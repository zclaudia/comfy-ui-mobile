import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentAttachment } from '@/infrastructure/api/AgentApi';
import { comfyAuthenticatedFetch } from '@/infrastructure/auth/ComfyAuthService';
import { ATTACHMENT_SUBFOLDER, attachmentKind, rejectReason } from './attachments';

/** Pixel size of an image or video, read locally so the model can judge orientation and scale even without vision. Best effort. */
export async function mediaDimensions(file: File, kind: AgentAttachment['kind']): Promise<{ width: number; height: number } | undefined> {
  if (kind !== 'image' && kind !== 'video') return undefined;
  const url = URL.createObjectURL(file);
  try {
    const size = await new Promise<{ width: number; height: number } | undefined>(resolve => {
      const timer = setTimeout(() => resolve(undefined), 8000);
      const done = (value?: { width: number; height: number }) => { clearTimeout(timer); resolve(value && value.width > 0 && value.height > 0 ? value : undefined); };
      if (kind === 'image') {
        const image = new Image();
        image.onload = () => done({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => done();
        image.src = url;
      } else {
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.onloadedmetadata = () => done({ width: video.videoWidth, height: video.videoHeight });
        video.onerror = () => done();
        video.src = url;
      }
    });
    return size;
  } finally { URL.revokeObjectURL(url); }
}

/** ComfyUI's upload endpoint accepts any file into the input folder; it returns the stored (possibly de-duplicated) name. */
export async function uploadAttachment(baseUrl: string, file: File, signal?: AbortSignal): Promise<AgentAttachment> {
  const kind = attachmentKind(file);
  const dimensions = mediaDimensions(file, kind); // overlaps with the upload; a failed read only drops the size fields
  const body = new FormData();
  body.append('image', file, file.name);
  body.append('subfolder', ATTACHMENT_SUBFOLDER);
  body.append('type', 'input');
  const response = await comfyAuthenticatedFetch(`${baseUrl.replace(/\/$/, '')}/upload/image`, { method: 'POST', body, signal });
  if (!response.ok) throw new Error(`上传失败 (${response.status})`);
  const result = await response.json().catch(() => ({})) as { name?: string; subfolder?: string; type?: string };
  if (!result.name) throw new Error('上传失败');
  return { filename: result.name, subfolder: result.subfolder ?? ATTACHMENT_SUBFOLDER, type: result.type === 'temp' ? 'temp' : 'input', kind, name: file.name, size: file.size, ...(await dimensions.catch(() => undefined)) };
}

export interface LocalAttachment {
  id: string; file: File; kind: AgentAttachment['kind']; previewUrl?: string;
  status: 'uploading' | 'done' | 'error'; uploaded?: AgentAttachment; error?: string;
}

/**
 * Uploads start as soon as a file is picked so sending only waits on stragglers. Object URLs are revoked on removal and
 * unmount. Side effects (uploads, toasts, object URLs) run outside state updaters so StrictMode's double invocation is harmless.
 */
export function useAttachments(baseUrl: string, onReject: (reason: string, file: File) => void) {
  const [items, setItems] = useState<LocalAttachment[]>([]);
  const latest = useRef(items); // mirrors state for callbacks that need the current list synchronously
  latest.current = items;
  const controllers = useRef(new Map<string, AbortController>());
  const commit = useCallback((next: LocalAttachment[]) => { latest.current = next; setItems(next); }, []);
  const patch = useCallback((id: string, update: Partial<LocalAttachment>) => commit(latest.current.map(item => item.id === id ? { ...item, ...update } : item)), [commit]);

  const upload = useCallback((item: LocalAttachment) => {
    const controller = new AbortController();
    controllers.current.set(item.id, controller);
    uploadAttachment(baseUrl, item.file, controller.signal)
      .then(uploaded => patch(item.id, { status: 'done', uploaded }))
      .catch(e => { if (!controller.signal.aborted) patch(item.id, { status: 'error', error: e instanceof Error ? e.message : '上传失败' }); })
      .finally(() => controllers.current.delete(item.id));
  }, [baseUrl, patch]);

  const add = useCallback((files: Iterable<File>) => {
    const next = [...latest.current];
    const added: LocalAttachment[] = [];
    for (const file of files) {
      const reason = rejectReason(file, next.length);
      if (reason) { onReject(reason, file); continue; }
      const kind = attachmentKind(file);
      const item: LocalAttachment = { id: crypto.randomUUID(), file, kind, status: 'uploading', previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined };
      next.push(item); added.push(item);
    }
    if (!added.length) return;
    commit(next);
    for (const item of added) upload(item);
  }, [commit, onReject, upload]);

  const release = useCallback((item: LocalAttachment) => { controllers.current.get(item.id)?.abort(); if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); }, []);
  const remove = useCallback((id: string) => {
    const gone = latest.current.find(item => item.id === id);
    if (!gone) return;
    release(gone);
    commit(latest.current.filter(item => item.id !== id));
  }, [commit, release]);
  const retry = useCallback((id: string) => {
    const item = latest.current.find(i => i.id === id);
    if (!item || item.status !== 'error') return;
    patch(id, { status: 'uploading', error: undefined });
    upload({ ...item, status: 'uploading', error: undefined });
  }, [patch, upload]);
  const clear = useCallback(() => { for (const item of latest.current) release(item); commit([]); }, [commit, release]);
  useEffect(() => () => { for (const item of latest.current) release(item); }, [release]);

  const uploaded = useMemo(() => items.flatMap(item => item.uploaded ? [item.uploaded] : []), [items]);
  const uploading = items.some(item => item.status === 'uploading');
  const failed = items.some(item => item.status === 'error');
  return { items, add, remove, retry, clear, uploaded, uploading, failed };
}
