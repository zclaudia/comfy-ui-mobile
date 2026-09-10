import type { MediaRef } from '../store.js';
import type { MediaKind } from './types.js';

export interface LocatedOutput extends MediaRef { kind: MediaKind; locator: string; displayOrdinal: number }
const extensions: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', avif: 'image', bmp: 'image', svg: 'image',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', m4v: 'video', avi: 'video',
  wav: 'audio', mp3: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', opus: 'audio',
};
/** Preserve output occurrences and their structural locations. Display caps must never discard asset identities. */
export function locateOutputs(raw: unknown, limit = 1024): { outputs: LocatedOutput[]; incomplete: boolean } {
  const outputs: LocatedOutput[] = [];
  const ordinals: Partial<Record<MediaKind, number>> = {};
  let incomplete = false, visited = 0;
  function visit(value: unknown, path: (string | number)[]) {
    if (++visited > 20_000 || path.length > 16) { incomplete = true; return; }
    if (!value || typeof value !== 'object') return;
    if (outputs.length >= limit) { incomplete = true; return; }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) { visit(value[i], [...path, i]); if (incomplete && (visited > 20_000 || outputs.length >= limit)) break; }
      return;
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.filename === 'string') {
      const kind = extensions[entry.filename.split('.').at(-1)?.toLowerCase() ?? ''];
      if (!kind) return;
      const type = entry.type ?? 'output', subfolder = entry.subfolder ?? '';
      if (!['input', 'output', 'temp'].includes(String(type)) || typeof subfolder !== 'string'
        || /[/\\]/.test(entry.filename) || entry.filename.includes('\0') || ['.', '..'].includes(entry.filename) || subfolder.split(/[/\\]/).includes('..')) { incomplete = true; return; }
      outputs.push({ filename: entry.filename, subfolder, type: String(type), kind, locator: JSON.stringify(path), displayOrdinal: ordinals[kind] = (ordinals[kind] ?? 0) + 1 });
      return;
    }
    for (const [key, child] of Object.entries(entry)) { visit(child, [...path, key]); if (incomplete && (visited > 20_000 || outputs.length >= limit)) break; }
  }
  visit(raw, []);
  return { outputs, incomplete };
}
