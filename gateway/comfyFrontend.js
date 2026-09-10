import { authorizeProxyRoute } from './routes.js';

export const COMFY_FRONTEND_PREFIX = '/comfy/';

/** A managed asset token is an identity, not a ComfyUI filename. */
export function comfyAssetPreviewId(url, method) {
  if (method !== 'GET' || !['/comfy/view', '/comfy/api/view'].includes(url.pathname)) return null;
  const match = /^asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(url.searchParams.get('filename') ?? '');
  return match?.[1] ?? null;
}

/** Keep the upstream frontend separate from the mobile build and preserve the API allowlist. */
export function comfyFrontendRoute(pathname, method, config) {
  if (!pathname.startsWith(COMFY_FRONTEND_PREFIX)) return null;
  const upstreamPath = pathname.slice(COMFY_FRONTEND_PREFIX.length - 1);
  let decoded;
  try { decoded = decodeURIComponent(upstreamPath); } catch { return { allowed: false, status: 400 }; }
  if (decoded.startsWith('//') || /[\\\x00-\x1f]/.test(decoded) || decoded.split('/').some(part => part === '..' || part === '.') || /%[0-9a-f]{2}/i.test(decoded)) return { allowed: false, status: 400 };
  const read = method === 'GET' || method === 'HEAD';
  if (read && (upstreamPath === '/' || /^\/(?:assets|extensions|scripts|templates|fonts)\/.+\.(?:js|mjs|css|json|map|wasm|woff2?|ttf|otf|png|jpe?g|gif|webp|avif|ico|svg|mp4|webm)$/.test(decoded)
    || /^\/(?:user\.css|materialdesignicons\.min\.css|favicon\.ico)$/.test(decoded))) {
    return { allowed: true, upstreamPath, document: upstreamPath === '/' };
  }
  const apiPath = decoded.startsWith('/api/') ? decoded.slice(4) : decoded;
  if (read && /^\/(?:extensions|embeddings|settings(?:\/[^/]+)?|users|features|server_features|workflow_templates|i18n|models(?:\/[^/]+)?|userdata(?:\/.*)?|global_subgraphs(?:\/[a-f0-9]{64})?|jobs(?:\/[^/]+)?|node_replacements|experiment\/models)$/.test(apiPath)) return { allowed: true, upstreamPath };
  const existing = authorizeProxyRoute(apiPath, method === 'HEAD' ? 'GET' : method, config);
  return { ...existing, upstreamPath };
}

export function comfyFrameAncestors(config) {
  const origins = [...config.allowedOrigins].filter(value => {
    try { const parsed = new URL(value); return ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === value; } catch { return false; }
  });
  return `frame-ancestors 'self' ${origins.join(' ')}`.trim();
}
