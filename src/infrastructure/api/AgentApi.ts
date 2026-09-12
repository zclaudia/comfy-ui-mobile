import { platformFetch } from '@/platform/http';
import { getNativeGatewayAuthorization } from '@/platform/gatewaySession';
import { isTauriRuntime } from '@/platform/runtime';
import { AgentRequestError } from './AgentRequestError';
export { AgentRequestError };

/** Which library workflow a draft started from: a record of origin, not a sync binding. */
export interface SourceRef { serverId: string; workflowId: string; filename: string; name: string; etag?: string }
export interface AgentMediaRef { filename: string; subfolder: string; type: string }
export type AgentAttachmentKind = 'image' | 'video' | 'audio' | 'file';
/** A file uploaded to ComfyUI's input folder and referenced by a chat message. */
export interface AgentAttachment extends AgentMediaRef { type: 'input' | 'temp'; kind: AgentAttachmentKind; name?: string; size?: number; width?: number; height?: number }
export type PreviewPolicy = 'auto' | 'confirm';
export interface AgentTask { id: string; state: string; error?: string; message: string; retries?: number }
export interface AgentEvent { seq: number; kind: string; taskId: string | null; data: Record<string, any>; created: number }
export interface AgentStatus { enabled: boolean; providerReady: boolean; model: string | null; modelId?: string | null; vision?: boolean; contextWindow?: number; maxOutputTokens?: number; agentSchemaVersion?: number; serverId?: string; activeTasks?: number; capabilities?: { multiDraft: boolean; assetReferences: boolean; selectionCards: boolean } }
export interface AgentModelInput { name: string; model: string; baseUrl: string; apiKey?: string; contextWindow: number; maxOutputTokens: number; vision: boolean; completionAudit?: boolean; stepTimeoutSeconds?: number }
export interface AgentModel extends Omit<AgentModelInput, 'apiKey'> { id: string; hasApiKey: boolean }
export interface AgentModels { models: AgentModel[]; activeId: string | null }
export class AgentTransport {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly schemaVersion = 1, private readonly expectedServerId?: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  /**
   * Every request carries a deadline. Without one a wedged native HTTP
   * request (flaky mobile network, stalled keep-alive connection) would hang
   * the promise forever, silently stopping the chat's snapshot polling loop.
   * Composed manually so older WebViews without AbortSignal.any still work.
   */
  protected async request<T>(path: string, init: { method?: string; body?: unknown } = {}, signal?: AbortSignal, timeoutMs = 60_000): Promise<T> {
    const url = `${this.baseUrl}/api/gateway/agent${path}`;
    const authorization = getNativeGatewayAuthorization(url);
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const deadline = new AbortController();
    const forwardAbort = () => deadline.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) deadline.abort();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    try {
      const response = await platformFetch(url, {
        method,
        credentials: isTauriRuntime() ? 'omit' : 'include',
        headers: { 'X-Agent-Schema-Version': String(this.schemaVersion), ...(this.expectedServerId ? { 'X-Agent-Server-Id': encodeURIComponent(this.expectedServerId) } : {}), ...(authorization ? { Authorization: authorization } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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
}
/** Status and model administration. Sessions, drafts, runs and assets live on the workspace contract in WorkspaceApi. */
export class AgentApi extends AgentTransport {
  status(signal?: AbortSignal) { return this.request<AgentStatus>('/status', {}, signal); }
  models(signal?: AbortSignal) { return this.request<AgentModels>('/models', {}, signal); }
  saveModel(input: AgentModelInput, id?: string) { return this.request<{ model: AgentModel }>(id ? `/models/${encodeURIComponent(id)}` : '/models', { method: id ? 'PUT' : 'POST', body: input }); }
  activateModel(id: string) { return this.request<AgentModels>(`/models/${encodeURIComponent(id)}/activate`, { body: {} }); }
  deleteModel(id: string) { return this.request<AgentModels>(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
}
