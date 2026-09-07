import { platformFetch } from '@/platform/http';
import { getNativeGatewayAuthorization } from '@/platform/gatewaySession';
import { isTauriRuntime } from '@/platform/runtime';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';
import { AgentRequestError } from './AgentRequestError';
export { AgentRequestError };

export interface SessionWorkflowRef { id: string; name: string; filename?: string }
export interface AgentMediaRef { filename: string; subfolder: string; type: string }
export type AgentAttachmentKind = 'image' | 'video' | 'audio' | 'file';
/** A file uploaded to ComfyUI's input folder and referenced by a chat message. */
export interface AgentAttachment extends AgentMediaRef { type: 'input' | 'temp'; kind: AgentAttachmentKind; name?: string; size?: number }
export interface AgentSession {
  id: string; name: string; version: number; created: number; workflow?: SessionWorkflowRef;
  preview?: string; lastMessage?: string; lastActivity?: number; active?: boolean; lastState?: string; thumbnail?: AgentMediaRef;
}
export interface AgentTask { id: string; state: string; error?: string; message: string }
export interface AgentEvent { seq: number; kind: string; taskId: string | null; data: Record<string, any>; created: number }
export interface AgentVersion { version: number; summary: string; saved: boolean; created: number }
export interface AgentSnapshot { session: AgentSession; tasks: AgentTask[]; versions: AgentVersion[]; events: AgentEvent[]; cursor: number; hasMore: boolean }
export interface AgentStatus { enabled: boolean; providerReady: boolean; model: string | null; modelId?: string | null; vision?: boolean; contextWindow?: number; maxOutputTokens?: number }
export interface AgentModelInput { name: string; model: string; baseUrl: string; apiKey?: string; contextWindow: number; maxOutputTokens: number; vision: boolean }
export interface AgentModel extends Omit<AgentModelInput, 'apiKey'> { id: string; hasApiKey: boolean }
export interface AgentModels { models: AgentModel[]; activeId: string | null }
export type SessionPatch = { name?: string; workflow?: SessionWorkflowRef | null };

export class AgentApi {
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/api/gateway/agent${path}`;
    const authorization = getNativeGatewayAuthorization(url);
    const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
    const response = await platformFetch(url, {
      method,
      credentials: isTauriRuntime() ? 'omit' : 'include',
      headers: { ...(authorization ? { Authorization: authorization } : {}), ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body), signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new AgentRequestError(response.status, result.error || `请求失败 (${response.status})`, result);
    return result as T;
  }
  status(signal?: AbortSignal) { return this.request<AgentStatus>('/status', {}, signal); }
  models(signal?: AbortSignal) { return this.request<AgentModels>('/models', {}, signal); }
  saveModel(input: AgentModelInput, id?: string) { return this.request<{ model: AgentModel }>(id ? `/models/${encodeURIComponent(id)}` : '/models', { method: id ? 'PUT' : 'POST', body: input }); }
  activateModel(id: string) { return this.request<AgentModels>(`/models/${encodeURIComponent(id)}/activate`, { body: {} }); }
  deleteModel(id: string) { return this.request<AgentModels>(`/models/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  sessions(signal?: AbortSignal) { return this.request<{ sessions: AgentSession[] }>('/sessions', {}, signal); }
  create(name: string, canvas?: IComfyJson, workflow?: SessionWorkflowRef) {
    return this.request<{ session: AgentSession }>('/sessions', { body: { name, ...(canvas ? { canvas } : {}), ...(workflow ? { workflow } : {}) } });
  }
  update(id: string, patch: SessionPatch) { return this.request<{ session: AgentSession }>(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }); }
  remove(id: string) { return this.request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  importVersion(id: string, canvas: IComfyJson, baseVersion: number, summary = '画布修改') {
    return this.request<{ version: number }>(`/sessions/${encodeURIComponent(id)}/versions`, { body: { canvas, baseVersion, summary } });
  }
  snapshot(id: string, after = 0, signal?: AbortSignal) { return this.request<AgentSnapshot>(`/sessions/${encodeURIComponent(id)}?after=${after}`, {}, signal); }
  message(id: string, message: string, requestId: string, attachments: AgentAttachment[] = []) {
    return this.request<{ taskId: string }>(`/sessions/${encodeURIComponent(id)}/messages`, { body: { message, requestId, ...(attachments.length ? { attachments } : {}) } });
  }
  cancel(id: string, taskId: string) { return this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { body: { taskId } }); }
  restore(id: string, version: number, baseVersion: number) { return this.request(`/sessions/${encodeURIComponent(id)}/restore`, { body: { version, baseVersion } }); }
  version(id: string, version: number) { return this.request<AgentVersion & { canvas: IComfyJson }>(`/sessions/${encodeURIComponent(id)}/versions/${version}`); }
}
