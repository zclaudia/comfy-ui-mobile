import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { shellWorker } from '../../build/offlineShell';

const origin = 'https://app.example/';
const content = { 'index.html': '<html><script src="/assets/app.js"></script></html>', 'assets/app.js': 'app v1', 'assets/lazy.js': 'lazy editor', 'assets/app.css': 'body{color:white}' };
const resources = Object.entries(content).map(([path, value]) => ({ path, digest: createHash('sha256').update(value).digest('hex') }));

function environment() {
  const stores = new Map<string, Map<string, Response>>();
  const requests: { url: string; options?: RequestInit }[] = [];
  const cache = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const values = stores.get(name)!;
      return { async put(url: string, response: Response) { values.set(url, response.clone()); }, async match(url: string) { return values.get(url)?.clone(); } };
    },
    async keys() { return [...stores.keys()]; }, async delete(name: string) { return stores.delete(name); },
  };
  let offline = false; let corrupt = false; let claimed = 0;
  const fetcher = async (url: string, options?: RequestInit) => {
    requests.push({ url, options });
    if (offline) throw new Error('network unavailable');
    const value = content[new URL(url).pathname.slice(1) as keyof typeof content];
    return new Response(corrupt ? 'different deployment' : value, { status: value === undefined ? 404 : 200 });
  };
  const handlers = new Map<string, (event: unknown) => void>();
  runInNewContext(shellWorker(resources), { self: { registration: { scope: origin }, clients: { claim: async () => { claimed++; } }, addEventListener: (kind: string, handler: (event: unknown) => void) => handlers.set(kind, handler) }, caches: cache, fetch: fetcher, URL, Uint8Array, crypto: webcrypto });
  const lifecycle = async (name: string) => { let done: Promise<unknown> | undefined; handlers.get(name)!({ waitUntil: (value: Promise<unknown>) => { done = value; } }); await done; };
  const request = (path: string, method = 'GET', mode = 'navigate') => {
    let response: Promise<Response> | undefined;
    handlers.get('fetch')!({ request: { url: new URL(path, origin).href, method, mode }, respondWith: (value: Promise<Response>) => { response = value; } }); return response;
  };
  const status = async (prepare = false) => {
    let result: { ready: boolean; version: string } | undefined; let done: Promise<unknown> | undefined;
    handlers.get('message')!({ data: { type: prepare ? 'OFFLINE_SHELL_PREPARE' : 'OFFLINE_SHELL_STATUS' }, ports: [{ postMessage: (value: typeof result) => { result = value; } }], waitUntil: (value: Promise<unknown>) => { done = value; } });
    await done; return result!;
  };
  return { stores, requests, lifecycle, request, status, offline: () => { offline = true; }, corrupt: () => { corrupt = true; }, claimed: () => claimed };
}

test('offline shell serves a complete build on a deep draft route without caching APIs, user media or writes', async () => {
  const f = environment();
  await f.lifecycle('install'); await f.lifecycle('activate');
  assert.equal(f.claimed(), 1); assert.equal((await f.status()).ready, true);
  assert.equal(f.requests.length, resources.length);
  assert.ok(f.requests.every(request => request.options?.credentials === 'omit' && request.options.redirect === 'error'));
  f.offline();
  const response = await f.request('/chat/1234-abcd/drafts/4567-abcd/canvas?revision=2&copy=old');
  assert.equal(await response!.text(), content['index.html']);
  assert.equal(await (await f.request('/assets/lazy.js', 'GET', 'cors'))!.text(), content['assets/lazy.js']);
  for (const path of ['/api/gateway/agent/sessions', '/view?filename=private.png', '/object_info', '/comfymobile/api/workflows/list', '/login', '/assets/app.js?token=secret', 'https://cdn.example/assets/app.js']) assert.equal(f.request(path), undefined, path);
  assert.equal(f.request('/chat/1234', 'POST'), undefined);
  assert.equal(f.requests.length, resources.length, 'offline navigation used only precached build resources');
});

test('a deployment mismatch cannot install a mixed build or delete the previous offline cache', async () => {
  const f = environment();
  f.stores.set('comfy-mobile-shell-previous', new Map([['old', new Response('old build')]]));
  f.corrupt();
  await assert.rejects(f.lifecycle('install'), /build changed/);
  assert.deepEqual([...f.stores.keys()], ['comfy-mobile-shell-previous']);
  assert.equal(f.claimed(), 0);
});

test('activation removes only obsolete app shells and readiness detects cache eviction', async () => {
  const f = environment();
  f.stores.set('other-application', new Map()); f.stores.set('comfy-mobile-shell-old', new Map());
  await f.lifecycle('install'); await f.lifecycle('activate');
  assert.ok(f.stores.has('other-application')); assert.equal(f.stores.has('comfy-mobile-shell-old'), false);
  const name = [...f.stores.keys()].find(key => key.startsWith('comfy-mobile-shell-'))!;
  f.stores.get(name)!.delete(new URL('assets/lazy.js', origin).href);
  assert.equal((await f.status()).ready, false);
  assert.equal((await f.status(true)).ready, true, 'an online startup can repair an evicted shell without deleting local drafts');
  assert.ok(f.stores.has('other-application'));
});
