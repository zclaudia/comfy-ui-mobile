import { AgentHttpError } from '../store.js';
import type { AgentEvent } from '../store.js';
import type { WorkspaceRepository } from './repository.js';
import type { RevisionRef } from './types.js';
import { runSummary } from './types.js';

/** Read migration evidence only. Never infer a historical target from today's head or a filename. */
export function legacyVersion(repository: WorkspaceRepository, sessionId: string, version: number) {
  const row = repository.db.prepare("SELECT data FROM legacy_workspace_refs WHERE session_id=? AND kind='version' AND legacy_key=?").get(sessionId, String(version));
  if (!row) throw new AgentHttpError(404, '此旧版本没有可确认的迁移映射');
  const reference = JSON.parse(String(row.data)) as RevisionRef;
  const revision = repository.revision(sessionId, reference.draftId, reference.revision);
  return { reference, revision, readOnly: true as const };
}

export function legacyTranscriptEvents(repository: WorkspaceRepository, sessionId: string, events: AgentEvent[]): AgentEvent[] {
  const get = repository.db.prepare('SELECT data FROM legacy_workspace_refs WHERE session_id=? AND kind=? AND legacy_key=?');
  const list = repository.db.prepare('SELECT legacy_key,data FROM legacy_workspace_refs WHERE session_id=? AND kind=? AND legacy_key>=? AND legacy_key<? ORDER BY legacy_key');
  return events.map(event => {
    if (!['workflow', 'result', 'execution_error', 'saved', 'state', 'approval', 'user'].includes(event.kind)
      || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) return event;
    const data = event.data as Record<string, unknown>;
    const runRow = get.get(sessionId, 'run_event', String(event.seq));
    const isLegacy = !!runRow || ['workflow', 'result', 'execution_error', 'saved', 'approval'].includes(event.kind)
      || (event.kind === 'user' && Array.isArray(data.attachments) && data.attachments.length > 0 && !data.context);
    if (!isLegacy) return event;
    let reference: RevisionRef | undefined;
    let run: ReturnType<typeof runSummary> | undefined;
    let incomplete = false;
    if (runRow) {
      const ref = JSON.parse(String(runRow.data)) as { runId: string };
      run = runSummary(repository.run(sessionId, ref.runId));
      reference = { draftId: run.draftId, revision: run.revision };
    } else if (Number.isSafeInteger(data.version) && Number(data.version) > 0) {
      try { reference = legacyVersion(repository, sessionId, Number(data.version)).reference; }
      catch (error) { if (!(error instanceof AgentHttpError) || error.status !== 404) throw error; incomplete = true; }
    }
    const assets = (kind: 'asset' | 'attachment') => list.all(sessionId, kind, `${event.seq}:`, `${event.seq};`).map(row => {
      const index = Number(String(row.legacy_key).slice(String(event.seq).length + 1));
      const ref = JSON.parse(String(row.data)) as { assetId: string };
      repository.asset(sessionId, ref.assetId);
      return { index, assetId: ref.assetId };
    }).sort((a, b) => a.index - b.index);
    const outputs = assets('asset'); const attachments = assets('attachment');
    if ((event.kind === 'result' || event.kind === 'execution_error') && !run) incomplete = true;
    if (Array.isArray(data.outputs) && outputs.length !== data.outputs.length) incomplete = true;
    if (Array.isArray(data.attachments) && attachments.length !== data.attachments.length) incomplete = true;
    return { ...event, data: { ...data, workspaceLegacy: { reference, run, outputs, attachments, incomplete } } };
  });
}
