import type { AgentStatus } from '../api/AgentApi';
import type { WorkspaceApi } from '../api/WorkspaceApi';
import type { IObjectInfo } from '../../shared/types/comfy/IComfyObjectInfo';
import type { DraftCopyIdentity, DraftCopyStore } from './DraftWorkingCopy';
import { draftCopyKey } from './DraftWorkingCopy';
import { canvasContextKey, canvasEnvironmentKey } from './DraftCanvasCache';
import type { DraftCanvasCache } from './DraftCanvasCache';

export interface DraftCanvasReader {
  status(signal: AbortSignal): Promise<AgentStatus>;
  api(serverId: string): Pick<WorkspaceApi, 'draft' | 'revision'>;
  objectInfo(signal: AbortSignal): Promise<IObjectInfo>;
}
export async function loadDraftCanvas(store: DraftCopyStore & DraftCanvasCache, baseUrl: string,
  reference: Omit<DraftCopyIdentity, 'serverId'>, reader: DraftCanvasReader, signal: AbortSignal) {
  const key = canvasContextKey(baseUrl, reference.sessionId, reference.draftId, reference.openedRevision);
  const cached = await store.readCanvasContext(key);
  const deadline = new AbortController(); const abort = () => deadline.abort();
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  const timer = setTimeout(abort, 8000);
  try {
    const status = await reader.status(deadline.signal);
    if (status.agentSchemaVersion !== 2 || !status.serverId) throw new Error('当前服务器不支持多工作流草稿');
    if (cached && cached.context.serverId !== status.serverId) throw new Error('服务器身份已变化，本机草稿保持离线');
    const api = reader.api(status.serverId);
    const [{ draft }, revision, objectInfo] = await Promise.all([
      api.draft(reference.sessionId, reference.draftId, deadline.signal), api.revision(reference.sessionId, reference.draftId, reference.openedRevision, deadline.signal), reader.objectInfo(deadline.signal),
    ]);
    signal.throwIfAborted();
    if (draft.sessionId !== reference.sessionId || draft.id !== reference.draftId || revision.sessionId !== reference.sessionId
      || revision.draftId !== reference.draftId || revision.revision !== reference.openedRevision || draft.headRevision < revision.revision) throw new Error('Invalid canvas context identity');
    const context = { key, baseUrl, serverId: status.serverId, draft, revision, cachedAt: Date.now() };
    let cacheError: unknown;
    try { await store.saveCanvasContext(context, { key: canvasEnvironmentKey(baseUrl, status.serverId), objectInfo, cachedAt: context.cachedAt }); }
    catch (error) { cacheError = error; }
    return { ...context, objectInfo, online: true, ...(cacheError ? { warning: '离线打开所需的数据未能保存，请保留恢复备份' } : {}) };
  } catch (error) {
    signal.throwIfAborted();
    if (!cached) throw error;
    const { context, environment } = cached;
    const identity = { ...reference, serverId: context.serverId };
    if (context.key !== key || canvasContextKey(context.baseUrl, context.draft.sessionId, context.draft.id, context.revision.revision) !== key
      || context.revision.sessionId !== reference.sessionId || context.revision.draftId !== reference.draftId
      || environment.key !== canvasEnvironmentKey(baseUrl, context.serverId)) throw new Error('Invalid cached canvas identity');
    const record = await store.read(draftCopyKey(identity));
    if (!record || draftCopyKey(record.identity) !== draftCopyKey(identity) || record.key !== draftCopyKey(identity)) throw new Error('没有可离线打开的本机草稿');
    return { ...context, objectInfo: environment.objectInfo, online: false,
      warning: deadline.signal.aborted ? '暂时无法连接服务器，已打开本机副本' : error instanceof Error ? error.message : '连接中断，正在重试' };
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
