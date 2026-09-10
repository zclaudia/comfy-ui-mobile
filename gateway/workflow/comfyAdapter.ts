import { checkedPrompt } from './engine.js';
import type { ObjectInfo } from './engine.js';

export class ComfyRequestError extends Error {
  constructor(public readonly status: number, public readonly details: unknown, public readonly outcomeUncertain = false) {
    super(outcomeUncertain ? 'ComfyUI submission outcome is uncertain; reconcile before retrying' : `ComfyUI request failed (${status})`);
    this.name = 'ComfyRequestError';
  }
}

/** Construct with trusted server config, never a model-provided URL or credential. */
export class ComfyAdapter {
  private readonly baseUrl: URL;
  constructor(private readonly config: { comfyUrl: string; comfyAuthToken?: string; timeoutMs?: number }) {
    this.baseUrl = new URL(config.comfyUrl);
    if (!['http:', 'https:'].includes(this.baseUrl.protocol) || this.baseUrl.username || this.baseUrl.password) {
      throw new Error('Expected an HTTP(S) ComfyUI URL without embedded credentials');
    }
  }

  private async request(path: string, body?: unknown, signal?: AbortSignal, maxBytes?: number): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    // Match the existing gateway proxy's ComfyUI authentication convention.
    if (this.config.comfyAuthToken) url.searchParams.set('token', this.config.comfyAuthToken);
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15_000);
    let response: Response;
    let data: unknown;
    try {
      response = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
      if (maxBytes) {
        if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new ComfyRequestError(413, undefined); }
        const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        if (reader) {
          try {
            while (true) {
              const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > maxBytes) { await reader.cancel(); throw new ComfyRequestError(413, undefined); }
              chunks.push(chunk.value);
            }
          } finally { reader.releaseLock(); }
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } else data = await response.json();
    } catch (error) {
      if (error instanceof ComfyRequestError) throw error;
      // Do not expose credential-bearing URLs through transport error messages.
      throw new ComfyRequestError(0, undefined, body !== undefined);
    }
    if (!response.ok) throw new ComfyRequestError(response.status, data, body !== undefined && response.status >= 500);
    return data;
  }

  /** Read a file from ComfyUI's input/output/temp folders. The caller bounds size and media type before use. */
  async getFile(ref: { filename: string; subfolder: string; type: string }, signal?: AbortSignal, maxBytes = 20 * 1024 * 1024): Promise<{ bytes: Uint8Array; mediaType: string }> {
    const url = new URL('/view', this.baseUrl);
    url.search = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type }).toString();
    if (this.config.comfyAuthToken) url.searchParams.set('token', this.config.comfyAuthToken);
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15_000);
    let response: Response;
    let bytes: Uint8Array;
    try {
      response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (!response.ok) throw new ComfyRequestError(response.status, undefined);
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > maxBytes) { await response.body?.cancel(); throw new ComfyRequestError(413, undefined); }
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > maxBytes) { await reader.cancel(); throw new ComfyRequestError(413, undefined); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    } catch (error) {
      if (error instanceof ComfyRequestError) throw error;
      throw new ComfyRequestError(0, undefined);
    }
    if (bytes.byteLength > maxBytes) throw new ComfyRequestError(413, undefined);
    return { bytes, mediaType: (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() };
  }

  async getObjectInfo(signal?: AbortSignal): Promise<ObjectInfo> {
    const result = await this.request('/object_info', undefined, signal);
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || Object.values(result).some(value => !value || !Array.isArray(value.output))) {
      throw new ComfyRequestError(502, { error: 'invalid_object_info' });
    }
    return result as ObjectInfo;
  }

  /** Formal workflow reads only. The browser remains the sole writer of library files. */
  async getWorkflow(filename: string, signal?: AbortSignal): Promise<{ content: unknown; etag: string; modified?: number } | null> {
    // eslint-disable-next-line no-control-regex -- reject filesystem control characters
    if (!filename || filename.includes('\\') || filename.split('/').some(part => !part || part === '.' || part === '..') || /[\x00-\x1f]/.test(filename)) throw new ComfyRequestError(400, undefined);
    const path = `/comfymobile/api/workflows/content/${filename.split('/').map(encodeURIComponent).join('/')}`;
    let result: unknown;
    try { result = await this.request(path, undefined, signal, 8 * 1024 * 1024); }
    catch (error) { if (error instanceof ComfyRequestError && error.status === 404) return null; throw error; }
    const data = result as { status?: unknown; content?: unknown; etag?: unknown; modified?: number };
    if (data?.status !== 'success' || !data.content || typeof data.content !== 'object' || typeof data.etag !== 'string' || !data.etag) throw new ComfyRequestError(502, undefined);
    return { content: data.content, etag: data.etag, modified: data.modified };
  }

  /** Copy generated image bytes into ComfyUI input storage for ordinary LoadImage nodes. */
  async uploadImage(file: { bytes: Uint8Array; mediaType: string }, filename: string, subfolder: string, signal?: AbortSignal): Promise<{ filename: string; subfolder: string; type: 'input' }> {
    const url = new URL('/upload/image', this.baseUrl);
    if (this.config.comfyAuthToken) url.searchParams.set('token', this.config.comfyAuthToken);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), filename);
    form.append('type', 'input');
    form.append('subfolder', subfolder);
    form.append('overwrite', 'false');
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 15_000);
    try {
      const response = await fetch(url, { method: 'POST', body: form, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      if (!response.ok) throw new ComfyRequestError(response.status, undefined);
      const data = await response.json() as { name?: unknown; subfolder?: unknown; type?: unknown };
      // eslint-disable-next-line no-control-regex -- reject NUL in returned file names
      if (typeof data.name !== 'string' || !data.name || /[/\\\x00]/.test(data.name) || ['.', '..'].includes(data.name)
        || data.subfolder !== subfolder || data.type !== 'input') throw new ComfyRequestError(502, undefined);
      return { filename: data.name, subfolder, type: 'input' };
    } catch (error) {
      if (error instanceof ComfyRequestError) throw error;
      throw new ComfyRequestError(0, undefined);
    }
  }

  getQueue(signal?: AbortSignal): Promise<unknown> { return this.request('/queue', undefined, signal); }

  getRecentHistory(signal?: AbortSignal): Promise<unknown> { return this.request('/history?max_items=200', undefined, signal); }

  getHistory(promptId: string, signal?: AbortSignal): Promise<unknown> {
    if (!/^[a-zA-Z0-9_-]+$/.test(promptId)) throw new Error('Invalid prompt ID');
    return this.request(`/history/${encodeURIComponent(promptId)}`, undefined, signal);
  }

  /** This enqueues actual GPU work. No automatic retries, no global interrupt tool. */
  async submit(value: unknown, info: ObjectInfo, context: { clientId: string; taskId: string; version: number; attemptId?: string; workflow?: unknown; sessionId?: string; draftId?: string; runId?: string }, signal?: AbortSignal): Promise<{ promptId: string; number?: number }> {
    if (!context.clientId || !context.taskId || !Number.isSafeInteger(context.version) || context.version < 0) throw new Error('Invalid submission context');
    const prompt = checkedPrompt(value, info);
    const result = await this.request('/prompt', {
      prompt,
      client_id: context.clientId,
      extra_data: {
        comfymobile_agent: { task_id: context.taskId, workflow_version: context.version, ...(context.attemptId ? { attempt_id: context.attemptId } : {}),
          ...(context.runId ? { run_id: context.runId, session_id: context.sessionId, draft_id: context.draftId, submission_key: context.attemptId } : {}) },
        ...(context.workflow === undefined ? {} : { extra_pnginfo: { workflow: context.workflow } }),
      },
    }, signal) as { prompt_id?: unknown; number?: unknown } | null;
    if (!result || typeof result.prompt_id !== 'string' || !result.prompt_id) {
      throw new ComfyRequestError(502, result, true);
    }
    return { promptId: result.prompt_id, ...(typeof result.number === 'number' ? { number: result.number } : {}) };
  }
}
