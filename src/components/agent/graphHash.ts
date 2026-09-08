/**
 * Content hash of a canvas graph: SHA-256 over `nodes` and `links` only, serialised with sorted keys.
 *
 * Cloud sync rewrites `extra` (name/description/tags/comfy_mobile_cloud) on upload and download, and the file ETag the
 * ComfyUI extension returns covers those bytes too. This hash is what decides "the draft matches the saved workflow";
 * the ETag only decides "the file changed on the server". Keep the two apart.
 */
export function canonicalGraph(canvas: unknown): string {
  const graph = { nodes: (canvas as { nodes?: unknown })?.nodes ?? [], links: (canvas as { links?: unknown })?.links ?? [] };
  return JSON.stringify(graph, (_key, value) => (value && typeof value === 'object' && !Array.isArray(value))
    ? Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(k => [k, (value as Record<string, unknown>)[k]]))
    : value);
}

export async function graphHash(canvas: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalGraph(canvas));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
