import { createHash, randomBytes } from 'node:crypto';

export const CANVAS_ACCESS_PREFIX = '/comfy/_access/';
const identifier = /^[A-Za-z0-9_-]{43}$/;
const fingerprint = headers => createHash('sha256').update(JSON.stringify(headers)).digest('hex');
const failure = (status, message) => Object.assign(new Error(message), { status });

/** Read-only frontend capabilities. Long-lived device/browser credentials never enter the iframe URL. */
export function createCanvasAccess(sessions, { now = Date.now, ttlMs = 30 * 60_000, maximum = 128, cookieName } = {}) {
  const entries = new Map();
  const credentials = request => {
    if (request.headers.authorization) return { authorization: request.headers.authorization };
    const cookie = String(request.headers.cookie ?? '').split(';').map(value => value.trim()).find(value => cookieName && value.startsWith(`${cookieName}=`));
    return cookie ? { cookie } : {};
  };
  const revoke = id => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id); clearTimeout(entry.timer);
    for (const socket of entry.sockets) socket.terminate();
  };
  const arm = entry => {
    clearTimeout(entry.timer);
    entry.expiresAt = now() + ttlMs;
    entry.timer = setTimeout(() => revoke(entry.id), ttlMs);
    entry.timer.unref();
  };
  const describe = entry => ({ id: entry.id, path: `${CANVAS_ACCESS_PREFIX}${entry.id}/`, expiresAt: entry.expiresAt, renewAfterMs: Math.floor(ttlMs / 3) });
  const authenticated = request => {
    if (!sessions.authenticate(request)) throw failure(401, 'gateway_authentication_required');
    return sessions.agentPrincipal(request) ?? 'anonymous';
  };
  const live = id => {
    const entry = entries.get(id);
    if (!entry || entry.expiresAt <= now() || !sessions.authenticate({ headers: entry.headers })) {
      revoke(id); return null;
    }
    return entry;
  };
  return {
    issue(request) {
      const principal = authenticated(request);
      for (const id of entries.keys()) live(id);
      if (entries.size >= maximum) throw failure(429, 'too_many_canvas_connections');
      const entry = { id: randomBytes(32).toString('base64url'), principal, headers: credentials(request), sockets: new Set() };
      arm(entry); entries.set(entry.id, entry); return describe(entry);
    },
    renew(request, id) {
      const principal = authenticated(request);
      const entry = live(id);
      if (!entry || entry.principal !== principal) throw failure(404, 'canvas_connection_not_found');
      entry.headers = credentials(request); arm(entry); return describe(entry);
    },
    revoke(id) { if (identifier.test(id)) revoke(id); },
    revokeCredentials(request) {
      const digest = fingerprint(credentials(request));
      for (const entry of entries.values()) if (fingerprint(entry.headers) === digest) revoke(entry.id);
    },
    resolve(request, pathname) {
      if (!pathname.startsWith(CANVAS_ACCESS_PREFIX)) return null;
      const match = /^\/comfy\/_access\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(pathname);
      const entry = match && live(match[1]);
      if (!entry) throw failure(401, 'canvas_connection_expired');
      if (!['GET', 'HEAD'].includes(request.method)) throw failure(403, 'canvas_connection_read_only');
      // Normal authorization, principal isolation and media ownership checks still run downstream.
      delete request.headers.authorization; delete request.headers.cookie;
      Object.assign(request.headers, entry.headers);
      delete request.headers.referer;
      request.canvasAccess = true;
      return { id: entry.id, pathname: `/comfy${match[2]}` };
    },
    watch(id, socket) {
      const entry = live(id);
      if (!entry) { socket.terminate(); return; }
      entry.sockets.add(socket);
      socket.once('close', () => entry.sockets.delete(socket));
    },
    clear() { for (const id of entries.keys()) revoke(id); },
  };
}
