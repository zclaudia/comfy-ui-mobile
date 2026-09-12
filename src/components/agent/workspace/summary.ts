import type { Draft, Run } from '../../../shared/types/agentWorkspace';
import type { WorkspaceViewState } from './state';

export type WorkspaceSummarySource = Pick<WorkspaceViewState, 'drafts' | 'runs' | 'snapshot'>;
export interface SummaryDraft { draft: Draft; latestRun?: Run; thumbnailAssetId?: string; outputCount: number; activity: number }
export interface WorkspaceSummary { drafts: SummaryDraft[]; outputs: string[]; moreDrafts: boolean; moreOutputs: boolean }

/** Event evidence outranks the copy a drafts page embedded, so a finished run never reappears as its older snapshot. */
function knownRuns(state: WorkspaceSummarySource): Run[] {
  const runs = new Map<string, Run>();
  for (const draft of Object.values(state.drafts)) if (draft.latestRun) runs.set(draft.latestRun.id, draft.latestRun);
  for (const run of Object.values(state.runs)) runs.set(run.id, run);
  return [...runs.values()].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
}

/**
 * What this chat has touched, read only from state the session already holds: every draft the agent worked on and
 * every file its runs produced, newest first. Archived drafts stay listed — they were still worked on — but sink
 * below the live ones.
 */
export function workspaceSummary(state: WorkspaceSummarySource): WorkspaceSummary {
  const runs = knownRuns(state);
  const byDraft = new Map<string, Run[]>();
  for (const run of runs) byDraft.set(run.draftId, [...(byDraft.get(run.draftId) ?? []), run]);
  const drafts = Object.values(state.drafts).map(draft => {
    const own = byDraft.get(draft.id) ?? [];
    const outputs = own.flatMap(run => run.outputAssetIds);
    return { draft, latestRun: own[0], thumbnailAssetId: outputs[0], outputCount: outputs.length, activity: Math.max(draft.updated, own[0]?.created ?? 0) };
  }).sort((a, b) => Number(a.draft.archivedAt != null) - Number(b.draft.archivedAt != null) || b.activity - a.activity || (a.draft.id < b.draft.id ? -1 : 1));
  return {
    drafts, outputs: [...new Set(runs.flatMap(run => run.outputAssetIds))],
    moreDrafts: state.snapshot?.drafts.nextCursor !== undefined, moreOutputs: state.snapshot?.runs.nextCursor !== undefined,
  };
}
