import { createHash } from 'node:crypto';

/** Canonical JSON for idempotency and logical revision identity, not an ETag for exported files. */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, normalize(item)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
