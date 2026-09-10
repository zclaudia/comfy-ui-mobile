import { platformFetch } from '../../platform/http';
import { getNativeGatewayAuthorization } from '../../platform/gatewaySession';
import { isTauriRuntime } from '../../platform/runtime';

export interface CanvasAccess {
  id: string;
  path: string;
  expiresAt: number;
  renewAfterMs: number;
}

export class CanvasAccessApi {
  constructor(private readonly baseUrl: string, private readonly transport = {
    fetch: platformFetch,
    authorization: getNativeGatewayAuthorization,
    native: isTauriRuntime(),
  }) {}

  private async request(method: string, path: string, signal?: AbortSignal): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/api/gateway/canvas-access${path}`;
    const authorization = this.transport.authorization(url);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 15000);
    try {
      const response = await this.transport.fetch(url, { method,
        credentials: this.transport.native ? 'omit' : 'include',
        headers: authorization ? { Authorization: authorization } : undefined,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Official canvas connection failed (HTTP ${response.status})`);
      return response.json();
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }

  private parse(value: unknown): CanvasAccess {
    const access = value as Partial<CanvasAccess> | null;
    if (!access || typeof access.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(access.id)
      || access.path !== `/comfy/_access/${access.id}/`
      || typeof access.expiresAt !== 'number' || !Number.isFinite(access.expiresAt)
      || typeof access.renewAfterMs !== 'number' || !Number.isFinite(access.renewAfterMs)
      || access.renewAfterMs < 1000 || access.renewAfterMs > 30 * 60_000) throw new Error('Invalid official canvas connection');
    return access as CanvasAccess;
  }

  async open(signal?: AbortSignal): Promise<CanvasAccess> { return this.parse(await this.request('POST', '', signal)); }
  async renew(access: CanvasAccess, signal?: AbortSignal): Promise<CanvasAccess> {
    const renewed = this.parse(await this.request('POST', `/${access.id}/renew`, signal));
    if (renewed.id !== access.id) throw new Error('Official canvas connection identity changed');
    return renewed;
  }
  async release(access: CanvasAccess): Promise<void> { await this.request('DELETE', `/${access.id}`); }
}
