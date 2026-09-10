import { readFileSync } from 'node:fs';
import type { MediaRef } from '../store.js';
import { ComfyAdapter, ComfyRequestError } from '../../workflow/comfyAdapter.js';
import type { ObjectInfo, Prompt } from '../../workflow/engine.js';

export const mediaKey = (ref: MediaRef) => JSON.stringify([ref.type, ref.subfolder, ref.filename]);
export class WorkspaceComfy extends ComfyAdapter {
  info: ObjectInfo = JSON.parse(readFileSync(new URL('./model-fixtures/object-info.json', import.meta.url), 'utf8'));
  files = new Map<string, Uint8Array>();
  submits = 0; complete = false; mode: 'ok' | 'lost' | 'unknown' = 'ok';
  history: Record<string, { prompt: [number, string, Prompt, { comfymobile_agent: { attempt_id: string; run_id?: string } }]; status: { completed: boolean; status_str: string }; outputs: unknown }> = {};
  constructor() { super({ comfyUrl: 'http://unused.invalid' }); }
  override async getObjectInfo() { return structuredClone(this.info); }
  override async getFile(ref: MediaRef, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const bytes = this.files.get(mediaKey(ref));
    if (!bytes) throw new ComfyRequestError(404, undefined);
    return { bytes, mediaType: 'application/octet-stream' };
  }
  override async uploadImage(file: { bytes: Uint8Array; mediaType: string }, filename: string, subfolder: string) {
    const ref = { filename, subfolder, type: 'input' as const };
    this.files.set(mediaKey(ref), file.bytes);
    const choices = this.info.LoadImage.input!.required!.image[0];
    if (Array.isArray(choices) && !choices.includes(filename)) choices.push(filename);
    return ref;
  }
  override async submit(value: unknown, info: ObjectInfo, context: Parameters<ComfyAdapter['submit']>[2]) {
    this.submits++;
    const prompt = value as Prompt;
    const promptId = `run-${this.submits}`;
    if (this.mode === 'unknown') throw new ComfyRequestError(0, undefined, true);
    const video = Object.values(prompt).some(node => node.class_type === 'MiniMaxH3ReferenceToVideo');
    this.history[promptId] = { prompt: [this.submits, promptId, prompt, { comfymobile_agent: { attempt_id: context.attemptId!, run_id: context.runId } }], status: { completed: true, status_str: 'success' },
      outputs: { '99': { images: [{ filename: video ? 'video.mp4' : 'image.png', subfolder: '', type: 'output' }] } } };
    if (this.mode === 'lost') throw new ComfyRequestError(0, undefined, true);
    return { promptId };
  }
  override async getQueue() { return { queue_running: this.complete ? [] : Object.values(this.history).map(run => run.prompt), queue_pending: [] }; }
  override async getRecentHistory() { return this.complete ? this.history : {}; }
  override async getHistory(id: string) { return this.complete ? { [id]: this.history[id] } : {}; }
}
