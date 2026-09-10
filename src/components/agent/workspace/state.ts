import type { AgentEvent } from '../../../infrastructure/api/AgentApi';
import type { Asset, Draft, LegacyWorkspaceEvent, RequestContext, Run, Selection, WorkspaceSnapshot } from '../../../shared/types/agentWorkspace';

export interface WorkspaceViewState {
  snapshot: WorkspaceSnapshot | null; events: AgentEvent[]; cursor: number; highWater: number;
  drafts: Record<string, Draft>; runs: Record<string, Run>; assets: Record<string, Asset>; questions: Record<string, Selection>;
  stamps: Record<string, number>;
}
export const emptyWorkspaceState = (): WorkspaceViewState => ({ snapshot: null, events: [], cursor: 0, highWater: 0, drafts: {}, runs: {}, assets: {}, questions: {}, stamps: {} });
export interface WorkspaceEntities { drafts?: Draft[]; runs?: Run[]; assets?: Asset[]; questions?: Selection[] }

/** A response started before newer event evidence cannot overwrite that evidence, including responses for old pages. */
export function mergeEntities(state: WorkspaceViewState, entities: WorkspaceEntities, observedAt: number): WorkspaceViewState {
  const next = { ...state, stamps: { ...state.stamps } };
  for (const collection of ['drafts', 'runs', 'assets', 'questions'] as const) {
    const values = entities[collection]; if (!values?.length) continue;
    const target: Record<string, Draft | Run | Asset | Selection> = { ...next[collection] };
    for (const value of values) {
      if (next.snapshot && value.sessionId !== next.snapshot.session.id) continue;
      const key = `${collection}:${value.id}`;
      if ((next.stamps[key] ?? -1) > observedAt) continue;
      target[value.id] = value; next.stamps[key] = observedAt;
    }
    Object.assign(next, { [collection]: target });
  }
  return next;
}

export function mergeWorkspaceSnapshot(previous: WorkspaceViewState, snapshot: WorkspaceSnapshot): WorkspaceViewState {
  let state = previous.snapshot && previous.snapshot.session.id !== snapshot.session.id ? emptyWorkspaceState() : previous;
  if (!state.snapshot || snapshot.highWater >= state.highWater) {
    state = mergeEntities({ ...state, snapshot, highWater: Math.max(state.highWater, snapshot.highWater) }, { drafts: snapshot.drafts.items, runs: snapshot.runs.items, questions: snapshot.questions }, snapshot.highWater);
  }
  const events = new Map(state.events.map(event => [event.seq, event]));
  for (const event of snapshot.events) {
    if (events.has(event.seq)) continue;
    events.set(event.seq, event);
    const legacy = event.data.workspaceLegacy as LegacyWorkspaceEvent | undefined;
    if (legacy?.run) state = mergeEntities(state, { runs: [legacy.run] }, snapshot.highWater);
    if (event.kind === 'draft_created' || event.kind === 'draft_changed') state = mergeEntities(state, { drafts: [event.data.draft as Draft] }, event.seq);
    if (event.kind === 'revision_created') {
      if (event.data.draft) state = mergeEntities(state, { drafts: [event.data.draft as Draft] }, event.seq);
      const prior = state.drafts[String(event.data.draftId)];
      if (prior && Number(event.data.revision) > prior.headRevision) state = mergeEntities(state, { drafts: [{ ...prior, headRevision: Number(event.data.revision), updated: event.created }] }, event.seq);
    }
    if (event.kind === 'run_state' || event.kind === 'workspace_result' || event.kind === 'workspace_execution_error') state = mergeEntities(state, { runs: [event.data.run as Run] }, event.seq);
    if (event.kind === 'asset_registered' || event.kind === 'asset_ready' || event.kind === 'asset_state') state = mergeEntities(state, { assets: [event.data.asset as Asset] }, event.seq);
    if (event.kind === 'selection_requested' || event.kind === 'selection_resolved') state = mergeEntities(state, { questions: [event.data.selection as Selection] }, event.seq);
  }
  return { ...state, events: [...events.values()].sort((a, b) => a.seq - b.seq), cursor: Math.max(state.cursor, snapshot.cursor), highWater: Math.max(state.highWater, snapshot.highWater) };
}

/** Keep one evolving card at the first durable event for each Run or question; tool lifecycle events remain intact. */
export function workspaceTranscriptEvents(events: AgentEvent[]): AgentEvent[] {
  const runs = new Set<string>(), questions = new Set<string>();
  return [...events].sort((a, b) => a.seq - b.seq).flatMap(original => {
    const legacy = original.data.workspaceLegacy as LegacyWorkspaceEvent | undefined;
    // Keep the original seq/task/timestamp and payload; only the presentation becomes a Run card.
    const event = legacy?.run ? { ...original, kind: 'run_state', data: { ...original.data, run: legacy.run } } : original;
    if (event.kind === 'run_state') { const id = String(event.data.run?.id); if (runs.has(id)) return []; runs.add(id); return [event]; }
    if (event.kind === 'selection_requested') { const id = String(event.data.selection?.id); if (questions.has(id)) return []; questions.add(id); return [event]; }
    return ['workspace_result', 'workspace_execution_error', 'selection_resolved', 'asset_ready', 'asset_state', 'asset_registered'].includes(event.kind) ? [] : [event];
  });
}

export function withReference(context: RequestContext, assetId: string): RequestContext {
  const selectedAssetIds = [...new Set([...(context.selectedAssetIds ?? []), assetId])];
  if (selectedAssetIds.length > 8) throw new Error('本轮参考素材不能超过 8 个');
  return { ...context, selectedAssetIds };
}
export const targetContext = (run: Pick<Run, 'draftId' | 'revision'>, action: RequestContext['action'] = 'edit_source'): RequestContext => ({ targetDraftId: run.draftId, sourceRevision: run.revision, action });
export const videoContext = (asset: Asset): RequestContext => {
  if (asset.kind !== 'image') throw new Error('请选择图片');
  return { selectedAssetIds: [asset.id], action: 'generate_video' };
};

/** Failed sends keep the same request ID only for exactly the same explicit text and references. */
export function messageIdentity(text: string, context: RequestContext, attachmentIds: string[]): string {
  return JSON.stringify([text, context.targetDraftId ?? null, context.sourceRevision ?? null, context.action ?? null, context.replyToEventSeq ?? null, context.selectedAssetIds ?? [], attachmentIds]);
}
