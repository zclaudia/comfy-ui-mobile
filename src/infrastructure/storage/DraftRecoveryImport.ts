import { z } from 'zod';
import type { WorkspaceApi } from '../api/WorkspaceApi';
import type { Draft } from '../../shared/types/agentWorkspace';
import type { DraftContent, DraftCopyIdentity, DraftCopyRecord, DraftCopyStore } from './DraftWorkingCopy';
import { draftCopyKey, sameDraftContent } from './DraftWorkingCopy';

export const MAX_DRAFT_RECOVERY_BYTES = 8 * 1024 * 1024;
const uuid = z.string().uuid();
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(300);
// Accept an editable, possibly not yet executable graph. Execution validation remains at the server boundary.
const canvas = z.object({
  version: z.number().finite(), last_node_id: z.number().finite(), last_link_id: z.number().finite(),
  nodes: z.array(z.object({ id: z.union([z.number().int(), text]), type: text,
    pos: z.tuple([z.number().finite(), z.number().finite()]), size: z.tuple([z.number().finite(), z.number().finite()]),
    widgets_values: z.array(z.unknown()).optional(), inputs: z.array(z.unknown()).optional(), outputs: z.array(z.unknown()).optional(),
  }).passthrough()).max(5000),
  links: z.array(z.array(z.unknown())).max(20000), groups: z.array(z.unknown()), config: z.unknown(), extra: z.unknown(),
}).passthrough();
const bindings = z.array(z.object({ id: text, nodeId: text, inputName: text, role: text, assetId: uuid }).strict()).max(8);
const content = z.object({ canvas, bindings }).strict();
const identity = z.object({ serverId: text, sessionId: uuid, draftId: uuid, openedRevision: revision, copyId: uuid.optional() }).strict();
const saveRequest = content.extend({ requestId: uuid, expectedHeadRevision: revision, sourceRevision: revision, summary: text });
const forkRequest = content.extend({ requestId: uuid, sourceRevision: revision, name: z.string().min(1).max(100) });
const rejected = z.object({ requestId: uuid, status: z.union([z.literal(400), z.literal(422)]), message: z.string() }).strict();
const schema = z.object({
  format: z.literal('comfy-mobile-draft-recovery'), schemaVersion: z.literal(1), created: z.number().finite().nonnegative(),
  record: z.object({ key: z.string(), epoch: revision, identity, sourceRevision: revision, expectedHeadRevision: revision,
    base: content, local: content, pending: saveRequest.optional(), rejected: rejected.optional(),
    rejectedRequests: z.array(z.object({ request: saveRequest, status: z.number(), message: z.string() }).strict()).optional(),
    fork: z.object({ request: forkRequest, result: z.object({ draftId: uuid, revision }).strict().optional() }).strict().optional(),
    recovery: z.object({ importedAt: z.number().finite().nonnegative(), reviewRequired: z.boolean() }).strict().optional(),
    discard: z.object({ requestedAt: z.number().finite().nonnegative() }).strict().optional(),
    discarded: z.object({ at: z.number().finite().nonnegative(), savedRevision: revision.optional(), forkedTo: z.object({ draftId: uuid, revision }).strict().optional() }).strict().optional(),
  }).strict(), local: content, memoryOnly: z.boolean(),
}).strict();
export interface DraftRecoveryDocument {
  format: 'comfy-mobile-draft-recovery'; schemaVersion: 1; created: number;
  record: DraftCopyRecord; local: DraftContent; memoryOnly: boolean;
}
export function parseDraftRecovery(value: string): DraftRecoveryDocument {
  if (new TextEncoder().encode(value).length > MAX_DRAFT_RECOVERY_BYTES) throw new Error('恢复文件不能超过 8 MB');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('恢复文件不是有效的 JSON'); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error('恢复文件格式不受支持或内容不完整');
  const document = result.data as DraftRecoveryDocument; const record = document.record;
  if (record.key !== draftCopyKey(record.identity) || record.sourceRevision < record.identity.openedRevision
    || record.expectedHeadRevision < record.sourceRevision
    || (record.pending && (record.pending.sourceRevision !== record.sourceRevision || record.pending.expectedHeadRevision !== record.expectedHeadRevision))
    || (record.fork && (record.fork.request.sourceRevision !== record.sourceRevision || !sameDraftContent(record.fork.request, document.local)))
    || (record.rejected && record.rejected.requestId !== record.pending?.requestId)) throw new Error('恢复文件的版本或请求关系不一致');
  return document;
}
type Reader = Pick<WorkspaceApi, 'draft' | 'revision' | 'asset'>;
type Scope = Pick<DraftCopyIdentity, 'serverId' | 'sessionId'>;
export async function inspectDraftRecovery(document: DraftRecoveryDocument, scope: Scope, api: Reader): Promise<Draft> {
  const { record } = document; const identity = record.identity;
  if (identity.serverId !== scope.serverId || identity.sessionId !== scope.sessionId) throw new Error('请在备份所属的服务器和对话中恢复');
  const [{ draft }, base] = await Promise.all([
    api.draft(scope.sessionId, identity.draftId), api.revision(scope.sessionId, identity.draftId, record.sourceRevision),
  ]);
  if (draft.id !== identity.draftId || draft.sessionId !== scope.sessionId || base.draftId !== identity.draftId || base.sessionId !== scope.sessionId
    || base.revision !== record.sourceRevision || draft.headRevision < record.expectedHeadRevision || !sameDraftContent(base, record.base)) throw new Error('恢复文件的基础版本与服务器记录不一致');
  if (identity.openedRevision !== record.sourceRevision) {
    const opened = await api.revision(scope.sessionId, identity.draftId, identity.openedRevision);
    if (opened.draftId !== identity.draftId || opened.sessionId !== scope.sessionId || opened.revision !== identity.openedRevision) throw new Error('恢复文件的基础版本与服务器记录不一致');
  }
  const contents = [record.base, record.local, document.local, record.pending, record.fork?.request].filter((value): value is DraftContent => !!value);
  const ids = [...new Set(contents.flatMap(item => item.bindings.map(binding => binding.assetId)))];
  await Promise.all(ids.map(async id => {
    const { asset } = await api.asset(scope.sessionId, id);
    if (asset.id !== id || asset.sessionId !== scope.sessionId) throw new Error('恢复文件引用了其他对话的素材');
  }));
  return draft;
}
/** Recheck the immutable base, then persist into a fresh local namespace. No server mutation is performed here. */
export async function importDraftRecovery(store: DraftCopyStore, document: DraftRecoveryDocument, scope: Scope, api: Reader): Promise<DraftCopyIdentity> {
  const checked = parseDraftRecovery(JSON.stringify(document));
  await inspectDraftRecovery(checked, scope, api);
  const identity = { ...checked.record.identity, copyId: crypto.randomUUID() };
  const record: DraftCopyRecord = { ...checked.record, identity, key: draftCopyKey(identity), epoch: 1, local: checked.local,
    recovery: { importedAt: Date.now(), reviewRequired: true } };
  // A file cannot prove a previous rejection or acknowledgement. Replay the original requests when the user resumes.
  delete record.rejected;
  delete record.discarded;
  if (record.fork) delete record.fork.result;
  await store.compareAndSwap(record.key, undefined, record);
  return identity;
}
