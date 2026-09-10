import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createCanvasAccess } from '../canvasAccess.js';

test('canvas capabilities are fixed to credentials, read-only, renewable by their principal and bounded by expiry', t => {
  let now = 1000;
  const active = new Set(['Bearer first', 'Bearer second']);
  const sessions = { authenticate: r => active.has(r.headers.authorization), agentPrincipal: r => r.headers.authorization };
  const access = createCanvasAccess(sessions, { now: () => now, ttlMs: 30000, maximum: 2 });
  t.after(() => access.clear());
  const first = { headers: { authorization: 'Bearer first', cookie: 'unrelated=secret' } };
  assert.throws(() => access.issue({ headers: {} }), { status: 401 });
  const grant = access.issue(first);
  assert.ok(!grant.path.includes('Bearer') && !grant.path.includes('secret'));
  const request = { method: 'GET', headers: { authorization: 'Bearer second', referer: `https://example.test${grant.path}` } };
  assert.deepEqual(access.resolve(request, grant.path + 'assets/app.js'), { id: grant.id, pathname: '/comfy/assets/app.js' });
  assert.deepEqual(request.headers, { authorization: 'Bearer first' });
  assert.throws(() => access.resolve({ method: 'POST', headers: {} }, grant.path + 'api/prompt'), { status: 403 });
  assert.throws(() => access.renew({ headers: { authorization: 'Bearer second' } }, grant.id), { status: 404 });
  now += 1000;
  assert.equal(access.renew(first, grant.id).expiresAt, now + 30000);
  const second = access.issue(first);
  assert.throws(() => access.issue(first), { status: 429 });
  access.revoke(second.id);
  const socket = new EventEmitter(); let closed = false;
  socket.terminate = () => { closed = true; socket.emit('close'); };
  access.watch(grant.id, socket);
  now += 30001;
  assert.throws(() => access.resolve({ method: 'GET', headers: {} }, grant.path), { status: 401 });
  assert.equal(closed, true);
  const revokedDevice = access.issue(first); active.delete('Bearer first');
  assert.throws(() => access.resolve({ method: 'GET', headers: {} }, revokedDevice.path), { status: 401 });
});

test('browser logout revokes only the credential and ignores unrelated cookies', t => {
  const sessions = { authenticate: r => /(?:^|;\s*)session=valid(?:;|$)/.test(r.headers.cookie ?? ''), agentPrincipal: () => 'administrator' };
  const access = createCanvasAccess(sessions, { cookieName: 'session' }); t.after(() => access.clear());
  const grant = access.issue({ headers: { cookie: 'other=before; session=valid' } });
  const request = { method: 'GET', headers: {} };
  access.resolve(request, grant.path);
  assert.deepEqual(request.headers, { cookie: 'session=valid' });
  access.revokeCredentials({ headers: { cookie: 'session=valid; other=after' } });
  assert.throws(() => access.resolve({ method: 'GET', headers: {} }, grant.path), { status: 401 });
});
