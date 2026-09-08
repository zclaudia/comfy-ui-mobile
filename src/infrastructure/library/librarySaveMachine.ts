/**
 * Saving a chat draft into the workflow library, as pure decisions.
 *
 * The Gateway records the intent (`librarySaveOp`) and the outcome (`lastLibrarySave`); this device performs one
 * conditional write against the ComfyUI extension. Everything that turns a server answer into the next state lives here
 * so it can be tested without a network: the service in LibrarySaveService.ts only sequences calls.
 */
import type { AgentSession, LibrarySave, LibrarySaveOp, LibrarySaveState } from '../api/AgentApi';
import { sanitizeCloudWorkflowFilename } from '../sync/cloudIdentity';

export interface LibraryTarget { serverId: string; workflowId: string; filename: string; name: string; expectedEtag?: string }

export const activeSaveStates: LibrarySaveState[] = ['pending', 'applying', 'reconciling'];
export const isSaveActive = (op?: LibrarySaveOp) => !!op && activeSaveStates.includes(op.state);

/** Where a save would go by default: the last save target, else the source the draft started from. Other servers do not count. */
export function saveTarget(session: Pick<AgentSession, 'sourceRef' | 'lastLibrarySave'>, serverId: string): LibraryTarget | undefined {
  const last = session.lastLibrarySave;
  if (last && last.serverId === serverId) return { serverId, workflowId: last.workflowId, filename: last.filename, name: last.name, expectedEtag: last.etag || undefined };
  const source = session.sourceRef;
  if (source && source.serverId === serverId) return { serverId, workflowId: source.workflowId, filename: source.filename, name: source.name, expectedEtag: source.etag };
  return undefined;
}

export type SaveAvailability =
  | { kind: 'busy'; op: LibrarySaveOp }
  | { kind: 'create' }
  | { kind: 'identical'; target: LibraryTarget }
  | { kind: 'update'; target: LibraryTarget }
  | { kind: 'conflict'; target: LibraryTarget; currentEtag?: string }
  | { kind: 'missing'; target: LibraryTarget };

/**
 * The six situations of the save panel. `remoteEtags` is the server listing (filename → etag); a target absent from it
 * has been deleted, a target whose etag moved has been edited elsewhere.
 */
export function saveAvailability({ session, serverId, graphHash, remoteEtags }: {
  session: Pick<AgentSession, 'sourceRef' | 'lastLibrarySave' | 'librarySaveOp'>; serverId: string; graphHash: string; remoteEtags: Map<string, string | undefined>;
}): SaveAvailability {
  if (isSaveActive(session.librarySaveOp)) return { kind: 'busy', op: session.librarySaveOp! };
  const target = saveTarget(session, serverId);
  if (!target) return { kind: 'create' };
  if (!remoteEtags.has(target.filename)) return { kind: 'missing', target };
  const current = remoteEtags.get(target.filename);
  if (target.expectedEtag && current && current !== target.expectedEtag) return { kind: 'conflict', target, currentEtag: current };
  // A source without an etag (older cloud metadata) is updated against whatever the server holds right now.
  const resolved = { ...target, expectedEtag: target.expectedEtag ?? current };
  const last = session.lastLibrarySave;
  if (last && last.filename === target.filename && last.graphHash === graphHash) return { kind: 'identical', target: resolved };
  return { kind: 'update', target: resolved };
}

/** A new library entry needs a free filename; the panel refuses names already in use instead of suffixing them. */
export const nameTaken = (name: string, remoteFilenames: Iterable<string>) => {
  const filename = sanitizeCloudWorkflowFilename(name);
  for (const existing of remoteFilenames) if (existing === filename) return true;
  return false;
};

export type SaveRequest =
  | { mode: 'create'; name: string; workflowId: string }
  | { mode: 'update'; target: LibraryTarget; name?: string };

/** Fixes everything a retry must not change: the draft version, its hash, the target filename and id. */
export function planSave({ request, serverId, draftVersion, graphHash, opId, startedBy, now }: {
  request: SaveRequest; serverId: string; draftVersion: number; graphHash: string; opId: string; startedBy: string; now: number;
}): LibrarySaveOp {
  const target = request.mode === 'create'
    ? { serverId, workflowId: request.workflowId, filename: sanitizeCloudWorkflowFilename(request.name), name: request.name.trim() }
    : { serverId, workflowId: request.target.workflowId, filename: request.target.filename, name: (request.name ?? request.target.name).trim(), expectedEtag: request.target.expectedEtag };
  return { opId, mode: request.mode, draftVersion, graphHash, target, state: 'pending', startedBy, startedAt: now, updatedAt: now };
}

export const withState = (op: LibrarySaveOp, state: LibrarySaveState, now: number, result?: LibrarySaveOp['result']): LibrarySaveOp =>
  ({ ...op, state, updatedAt: now, ...(result ? { result } : {}) });

export interface SaveDecision { op: LibrarySaveOp; lastLibrarySave?: LibrarySave }

const finished = (op: LibrarySaveOp, etag: string, now: number): SaveDecision => ({
  op: withState(op, 'succeeded', now, { etag }),
  lastLibrarySave: { serverId: op.target.serverId, workflowId: op.target.workflowId, filename: op.target.filename, name: op.target.name, draftVersion: op.draftVersion, graphHash: op.graphHash, etag, opId: op.opId, at: now },
});

/**
 * After the conditional write. A 409 is a definite answer (someone else changed or created the file). Any other failure
 * may have reached the server, so it goes to `reconciling` rather than `failed`: the file is read back before deciding.
 */
export function decideAfterWrite(op: LibrarySaveOp, write: { success: boolean; conflict?: boolean; etag?: string; error?: string }, now: number): SaveDecision {
  if (write.success && write.etag) return finished(op, write.etag, now);
  if (write.success) return { op: withState(op, 'reconciling', now, { error: '服务器未返回 ETag' }) };
  if (write.conflict) return { op: withState(op, 'conflict', now, { error: write.error ?? (op.mode === 'create' ? '同名工作流已存在' : '工作流已被其他设备修改') }) };
  return { op: withState(op, 'reconciling', now, { error: write.error ?? '写入结果未知' }) };
}

/** After reading the target back. The file is ours only if it carries this operation's id and the fixed draft's graph hash. */
export function decideAfterReconcile(op: LibrarySaveOp, read: { found: boolean; saveOpId?: string; graphHash?: string; etag?: string }, now: number): SaveDecision {
  if (!read.found) {
    return op.mode === 'create'
      ? { op: withState(op, 'failed', now, { error: '写入未到达服务器' }) }
      : { op: withState(op, 'conflict', now, { error: '目标工作流已不存在' }) };
  }
  if (read.saveOpId === op.opId && read.graphHash === op.graphHash && read.etag) return finished(op, read.etag, now);
  return { op: withState(op, 'conflict', now, { error: '目标已被其他操作修改' }) };
}
