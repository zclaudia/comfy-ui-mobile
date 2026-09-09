import { platformFetch } from '@/platform/http';
import { getNativeGatewayAuthorization } from '@/platform/gatewaySession';
import { isTauriRuntime } from '@/platform/runtime';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import { AgentRequestError } from './AgentRequestError';
export { AgentRequestError };

/** The pre-draft one-to-one binding. Only read back from `legacyWorkflow` while migrating; never written again. */
export interface SessionWorkflowRef { id: string; name: string; filename?: string }
/** Which library workflow a draft started from: a record of origin, not a sync binding. */
export interface SourceRef { serverId: string; workflowId: string; filename: string; name: string; etag?: string }
/** The draft version the user last saved into the library and what the server returned for it. */
export interface LibrarySave { serverId: string; workflowId: string; filename: string; name: string; draftVersion: number; graphHash: string; etag: string; opId: string; at: number }
export type LibrarySaveState = 'pending' | 'applying' | 'reconciling' | 'succeeded' | 'conflict' | 'failed';
export interface LibrarySaveOp {
  opId: string; mode: 'create' | 'update'; draftVersion: number; graphHash: string;
  target: { serverId: string; workflowId: string; filename: string; name: string; expectedEtag?: string };
  state: LibrarySaveState; startedBy: string; startedAt: number; updatedAt: number; result?: { etag?: string; error?: string };
}
export interface AgentMediaRef { filename: string; subfolder: string; type: string }
export type AgentAttachmentKind = 'image' | 'video' | 'audio' | 'file';
/** A file uploaded to ComfyUI's input folder and referenced by a chat message. */
export interface AgentAttachment extends AgentMediaRef { type: 'input' | 'temp'; kind: AgentAttachmentKind; name?: string; size?: number; width?: number; height?: number }
export type PreviewPolicy = 'auto' | 'confirm';
export interface AgentSession {
  id: string; name: string; version: number; created: number;
  workspaceMode?: 'draft' | 'legacy'; sourceRef?: SourceRef; lastLibrarySave?: LibrarySave; librarySaveOp?: LibrarySaveOp;
  legacyWorkflow?: SessionWorkflowRef; previewPolicy?: PreviewPolicy;
  preview?: string; lastMessage?: string; lastActivity?: number; active?: boolean; lastState?: string;
  thumbnail?: AgentMediaRef & { kind?: 'image' | 'video' | 'audio' };
}
/** A submit_preview the model asked for that waits on the user; `decision` appears once answered, before the scheduler settles it. */
export interface AgentApproval { callId: string; version: number; requested: number; decision?: 'approved' | 'declined' }
export interface AgentTask { id: string; state: string; error?: string; message: string; approval?: AgentApproval; retries?: number }
export interface AgentEvent { seq: number; kind: string; taskId: string | null; data: Record<string, any>; created: number }
export interface AgentVersion { version: number; summary: string; saved: boolean; created: number }
export interface AgentSnapshot { session: AgentSession; tasks: AgentTask[]; versions: AgentVersion[]; versionsHasMore?: boolean; events: AgentEvent[]; cursor: number; hasMore: boolean }
export interface AgentStatus { enabled: boolean; providerReady: boolean; model: string | null; modelId?: string | null; vision?: boolean; contextWindow?: number; maxOutputTokens?: number }
export interface AgentModelInput { name: string; model: string; baseUrl: string; apiKey?: string; contextWindow: number; maxOutputTokens: number; vision: boolean; completionAudit?: boolean; stepTimeoutSeconds?: number }
export interface AgentModel extends Omit<AgentModelInput, 'apiKey'> { id: string; hasApiKey: boolean }
export interface AgentModels { models: AgentModel[]; activeId: string | null }
export type SessionPatch = {
  name?: string; sourceRef?: SourceRef | null; lastLibrarySave?: LibrarySave; librarySaveOp?: LibrarySaveOp;
  workspaceMode?: 'draft'; previewPolicy?: PreviewPolicy;
};

export class AgentApi {
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  /**
   * Every request carries a deadline. Without one a wedged native HTTP
   * request (flaky mobile network, stalled keep-alive connection) would hang
   * the promise forever, silently stopping the chat's snapshot polling loop.
   * Composed manually so older WebViews without AbortSignal.any still work.
   */
  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    const url = `${this.baseUrl}/api/gateway/agent${path}`;
    const authorization = getNativeGatewayAuthorization(url);
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const deadline = new AbortController();
    const forwardAbort = () => deadline.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      const response = await platformFetch(url, {
        method,
        credentials: isTauriRuntime() ? 'omit' : 'include',
        headers: { ...(authorization ? { Authorization: authorization } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: deadline.signal,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new AgentRequestError(response.status, result.error || `请求失败 (${response.status})`, result);
      return result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }
  }
  status(signal?: AbortSignal) { return this.request<AgentStatus>('/status', {}, signal); }
  models(signal?: AbortSignal) { return this.request<AgentModels>('/models', {}, signal); }
  saveModel(input: AgentModelInput, id?: string) { return this.request<{ model: AgentModel }>(id ? `/models/${encodeURIComponent(id)}` : '/models', { method: id ? 'PUT' : 'POST', body: input }); }
  activateModel(id: string) { return this.request<AgentModels>(`/models/${encodeURIComponent(id)}/activate`, { body: {} }); }
  deleteModel(id: string) { return this.request<AgentModels>(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  sessions(signal?: AbortSignal) { return this.request<{ sessions: AgentSession[] }>('/sessions', {}, signal); }
  create(name: string, canvas?: IComfyJson, sourceRef?: SourceRef) {
    return this.request<{ session: AgentSession }>('/sessions', { body: { name, ...(canvas ? { canvas } : {}), ...(sourceRef ? { sourceRef } : {}) } });
  }
  update(id: string, patch: SessionPatch) { return this.request<{ session: AgentSession }>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); }
  remove(id: string) { return this.request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  importVersion(id: string, canvas: IComfyJson, baseVersion: number, summary = '画布修改', requestId?: string) {
    return this.request<{ version: number }>(`/sessions/${encodeURIComponent(id)}/versions`, { body: { canvas, baseVersion, summary, ...(requestId ? { requestId } : {}) } });
  }
  versions(id: string, before?: number, limit = 50) {
    const query = new URLSearchParams({ limit: String(limit), ...(before === undefined ? {} : { before: String(before) }) });
    return this.request<{ versions: AgentVersion[]; hasMore: boolean }>(`/sessions/${encodeURIComponent(id)}/versions?${query}`);
  }
  snapshot(id: string, after = 0, signal?: AbortSignal) { return this.request<AgentSnapshot>(`/sessions/${encodeURIComponent(id)}?after=${after}`, {}, signal, 15_000); }
  message(id: string, message: string, requestId: string, attachments: AgentAttachment[] = []) {
    return this.request<{ taskId: string }>(`/sessions/${encodeURIComponent(id)}/messages`, { body: { message, requestId, ...(attachments.length ? { attachments } : {}) } });
  }
  cancel(id: string, taskId: string) { return this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { body: { taskId } }); }
  approve(id: string, taskId: string, callId: string, approved: boolean) { return this.request<{ state: string }>(`/sessions/${encodeURIComponent(id)}/approve`, { body: { taskId, callId, approved } }); }
  restore(id: string, version: number, baseVersion: number) { return this.request(`/sessions/${encodeURIComponent(id)}/restore`, { body: { version, baseVersion } }); }
  version(id: string, version: number) { return this.request<AgentVersion & { canvas: IComfyJson }>(`/sessions/${encodeURIComponent(id)}/versions/${version}`); }
}
