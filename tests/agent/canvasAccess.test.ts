import assert from 'node:assert/strict';
import test from 'node:test';
import { CanvasAccessApi } from '../../src/infrastructure/api/CanvasAccessApi';

const id = 'a'.repeat(43);
const grant = { id, path: `/comfy/_access/${id}/`, expiresAt: Date.now() + 1800000, renewAfterMs: 600000 };

test('native iframe access exchanges a header credential for a scoped path and refreshes credentials only on parent requests', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let authorization: string | null = 'Bearer native-device';
  const api = new CanvasAccessApi('http://gateway.test', {
    native: true,
    authorization: url => { assert.ok(url.startsWith('http://gateway.test/api/gateway/canvas-access')); return authorization; },
    fetch: async (input, init) => { calls.push({ url: String(input), init }); return Response.json(init?.method === 'DELETE' ? { revoked: true } : grant); },
  });
  const opened = await api.open();
  assert.equal(calls[0].url, 'http://gateway.test/api/gateway/canvas-access');
  assert.equal(calls[0].init?.credentials, 'omit');
  assert.equal(new Headers(calls[0].init?.headers).get('authorization'), authorization);
  assert.ok(!opened.path.includes('native-device'));
  authorization = 'Bearer refreshed-device'; await api.renew(opened);
  assert.equal(new Headers(calls[1].init?.headers).get('authorization'), authorization);
  authorization = null; await api.release(opened);
  assert.equal(calls[2].init?.method, 'DELETE');
  assert.equal(new Headers(calls[2].init?.headers).get('authorization'), null);
});

test('canvas access refuses foreign URLs, changed identities and invalid renewal intervals', async () => {
  let result: unknown = { ...grant, path: 'https://other.test/frame' };
  const api = new CanvasAccessApi('https://gateway.test', { native: false, authorization: () => null,
    fetch: async (_input, init) => { assert.equal(init?.credentials, 'include'); return Response.json(result); },
  });
  await assert.rejects(api.open(), /Invalid official canvas connection/);
  result = { ...grant, renewAfterMs: 0 }; await assert.rejects(api.open(), /Invalid official canvas connection/);
  const otherId = 'b'.repeat(43); result = { ...grant, id: otherId, path: `/comfy/_access/${otherId}/` };
  await assert.rejects(api.renew(grant), /identity changed/);
});

test('a cancelled canvas request is aborted and authorization failure never falls back to an unprotected iframe', async () => {
  const controller = new AbortController(); controller.abort();
  const api = new CanvasAccessApi('http://gateway.test', { native: true, authorization: () => 'Bearer device',
    fetch: async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    },
  });
  await assert.rejects(api.open(controller.signal), { name: 'AbortError' });
  await assert.rejects(api.open(), /HTTP 401/);
});
