import { platformFetch } from '@/platform/http';
import { getNativeGatewayAuthorization } from '@/platform/gatewaySession';
import { isTauriRuntime } from '@/platform/runtime';
import type { IComfyJson } from '@/shared/types/app/IComfyJson';

export interface AgentSession { preview?: string; id: string; name: string; version: number; created: number }
export interface AgentTask { id: string; state: string; error?: string; message: string }
export interface AgentEvent { seq: number; kind: string; taskId: string | null; data: Record<string, any>; created: number }
export interface AgentVersion { version: number; summary: string; saved: boolean; created: number }
export interface AgentSnapshot { session: AgentSession; tasks: AgentTask[]; versions: AgentVersion[]; events: AgentEvent[]; cursor: number; hasMore: boolean }
export interface AgentStatus { enabled: boolean; providerReady: boolean; model: string | null }

export class AgentApi {
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl.replace(/\/$/, ''); }
  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/api/gateway/agent${path}`;
    const authorization = getNativeGatewayAuthorization(url);
    const response = await platformFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: isTauriRuntime() ? 'omit' : 'include',
      headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
    return result as T;
  }
  status(signal?: AbortSignal) { return this.request<AgentStatus>('/status', undefined, signal); }
  sessions(signal?: AbortSignal) { return this.request<{ sessions: AgentSession[] }>('/sessions', undefined, signal); }
  create(name: string, canvas?: IComfyJson) { return this.request<{ session: AgentSession }>('/sessions', { name, ...(canvas ? { canvas } : {}) }); }
  snapshot(id: string, after = 0, signal?: AbortSignal) { return this.request<AgentSnapshot>(`/sessions/${encodeURIComponent(id)}?after=${after}`, undefined, signal); }
  message(id: string, message: string, requestId: string) { return this.request<{ taskId: string }>(`/sessions/${encodeURIComponent(id)}/messages`, { message, requestId }); }
  cancel(id: string, taskId: string) { return this.request(`/sessions/${encodeURIComponent(id)}/cancel`, { taskId }); }
  restore(id: string, version: number, baseVersion: number) { return this.request(`/sessions/${encodeURIComponent(id)}/restore`, { version, baseVersion }); }
  save(id: string, version: number) { return this.request(`/sessions/${encodeURIComponent(id)}/save`, { version }); }
  version(id: string, version: number) { return this.request<AgentVersion & { canvas: IComfyJson }>(`/sessions/${encodeURIComponent(id)}/versions/${version}`); }
}
