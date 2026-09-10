import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { loadGatewayConfig } from '../config.js';
import { createGatewayServer } from '../server.js';
import { comfyFrontendRoute, comfyFrameAncestors, comfyAssetPreviewId } from '../comfyFrontend.js';

const token = 'frontend-test-token-with-enough-entropy';
test('managed preview tokens match only exact read routes and immutable asset IDs', () => {
  const id = '25e13be5-7dbf-4319-aa68-635aa14389df';
  for (const path of ['/comfy/view', '/comfy/api/view']) {
    assert.equal(comfyAssetPreviewId(new URL(`http://localhost${path}?filename=asset%3A${id}&type=input`), 'GET'), id);
    assert.equal(comfyAssetPreviewId(new URL(`http://localhost${path}?filename=asset%3A${id}`), 'POST'), null);
  }
  for (const path of [`/view?filename=asset:${id}`, '/comfy/api/view?filename=cat.png', `/comfy/api/view?filename=asset:${id}/../secret`]) {
    assert.equal(comfyAssetPreviewId(new URL('http://localhost' + path), 'GET'), null);
  }
});
test('frontend prefix cannot broaden the API allowlist or redirect proxy requests to another host', () => {
  const config = { allowDangerousActions: false, allowedOrigins: new Set(['http://tauri.localhost', 'https://example.test', 'https://bad.test;script-src *', '*']) };
  for (const path of ['/comfy/', '/comfy/assets/app.js', '/comfy/scripts/app.js', '/comfy/extensions/node/main.js', '/comfy/api/extensions', '/comfy/api/object_info']) assert.equal(comfyFrontendRoute(path, 'GET', config).allowed, true, path);
  for (const path of ['/comfy//other.test/a.js', '/comfy/%2fother.test/a.js', '/comfy/assets/%252e%252e/private.js', '/comfy/assets/../private.js', '/comfy/assets/%5cother.js', '/comfy/api/gateway/devices', '/comfy/api/manager/install', '/comfy/api/userdata/../private']) assert.equal(comfyFrontendRoute(path, 'GET', config).allowed, false, path);
  assert.equal(comfyFrontendRoute('/comfy/comfymobile/api/reboot', 'POST', config).status, 403);
  assert.equal(comfyFrontendRoute('/comfy/api/userdata/workflows/original.json', 'POST', config).allowed, false);
  assert.equal(comfyFrontendRoute('/assets/mobile.js', 'GET', config), null);
  assert.equal(comfyFrameAncestors(config), "frame-ancestors 'self' http://tauri.localhost https://example.test");
});

test('official frontend has an authenticated separate root, restricted frame policy and prefixed WebSocket', async t => {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie });
    res.writeHead(200, { 'Content-Type': req.url === '/' ? 'text/html' : 'application/json', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'", 'Set-Cookie': 'upstream=secret' });
    res.end(req.url === '/' ? '<html><script src="./assets/app.js"></script></html>' : JSON.stringify({ path: req.url }));
  });
  const sockets = new WebSocketServer({ server: upstream });
  sockets.on('connection', (socket, req) => socket.send(req.url));
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => { sockets.clients.forEach(s => s.terminate()); sockets.close(); upstream.closeAllConnections(); upstream.close(); });
  const dir = mkdtempSync(join(tmpdir(), 'comfy-frontend-')); writeFileSync(join(dir, 'index.html'), 'mobile shell');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { ...loadGatewayConfig({ GATEWAY_AUTH_TOKEN: token, COMFYUI_URL: `http://127.0.0.1:${upstream.address().port}`, GATEWAY_STATIC_DIR: dir, GATEWAY_DEVICE_STORE: join(dir, 'devices.json'), GATEWAY_ALLOWED_ORIGINS: 'http://tauri.localhost' }), host: '127.0.0.1', port: 0 };
  const previews = [];
  const gateway = createGatewayServer(config, { agentService: { start() {}, async stop() {} },
    agentRequestHandler: async (_agent, owner, request, response, url) => {
      previews.push({ owner, path: url.pathname, query: url.search, range: request.headers.range });
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end('managed preview');
    } });
  const address = await gateway.start(); t.after(() => gateway.stop());
  const base = `http://127.0.0.1:${address.port}`; const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(base + '/comfy/')).status, 401);
  assert.equal((await fetch(base + '/comfy/assets/app.js')).status, 401);
  const mobile = await fetch(base + '/'); assert.equal(await mobile.text(), 'mobile shell'); assert.equal(mobile.headers.get('x-frame-options'), 'DENY');
  const frontend = await fetch(base + '/comfy/', { headers }); assert.equal(frontend.status, 200); assert.match(await frontend.text(), /\.\/assets\/app.js/);
  assert.equal(frontend.headers.get('x-frame-options'), null);
  assert.equal(frontend.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'self' http://tauri.localhost");
  assert.equal(frontend.headers.get('set-cookie'), null);
  const definitions = await fetch(base + '/comfy/api/object_info?test=1', { headers }); assert.deepEqual(await definitions.json(), { path: '/api/object_info?test=1' });
  assert.ok(requests.every(r => !r.authorization && !r.cookie));
  const count = requests.length;
  const previewPath = '/comfy/api/view?filename=asset%3A25e13be5-7dbf-4319-aa68-635aa14389df&type=input';
  assert.equal((await fetch(base + previewPath)).status, 401); assert.equal(previews.length, 0);
  const preview = await fetch(base + previewPath, { headers: { ...headers, Range: 'bytes=0-7' } });
  assert.equal(await preview.text(), 'managed preview'); assert.equal(previews.length, 1);
  assert.ok(previews[0].owner); assert.equal(previews[0].path, '/api/gateway/agent/assets/25e13be5-7dbf-4319-aa68-635aa14389df/content');
  assert.equal(previews[0].query, ''); assert.equal(previews[0].range, 'bytes=0-7');
  assert.equal(requests.length, count, 'managed assets never fall through to upstream filenames');
  assert.equal((await fetch(base + '/comfy/comfymobile/api/reboot', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(base + '/comfy/api/gateway/devices', { headers })).status, 404);
  assert.equal(requests.length, count);
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/comfy/ws?clientId=prefix-test', { headers });
  t.after(() => socket.terminate());
  const [message] = await once(socket, 'message'); assert.equal(message.toString(), '/ws?clientId=prefix-test');
  // Native WebViews have no Gateway cookie and cannot attach a Bearer header to iframe/subresource loads.
  assert.equal((await fetch(base + '/api/gateway/canvas-access', { method: 'POST' })).status, 401);
  const granted = await fetch(base + '/api/gateway/canvas-access', { method: 'POST', headers });
  assert.equal(granted.status, 201); assert.equal(granted.headers.get('cache-control'), 'no-store');
  const access = await granted.json();
  const embedded = await fetch(base + access.path);
  assert.equal(embedded.status, 200); assert.match(await embedded.text(), /\.\/assets\/app.js/);
  assert.equal(embedded.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(embedded.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + access.path + 'assets/app.js')).status, 200);
  const capabilityPreview = await fetch(base + access.path + previewPath.slice('/comfy/'.length));
  assert.equal(await capabilityPreview.text(), 'managed preview');
  assert.equal((await fetch(base + access.path + 'api/prompt', { method: 'POST', headers })).status, 403);
  assert.equal((await fetch(base + access.path + 'api/gateway/devices')).status, 404);
  assert.equal((await fetch(base + '/api/gateway/canvas-access/' + access.id + '/renew', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/api/gateway/canvas-access/' + access.id + '/renew', { method: 'POST', headers })).status, 200);
  const embeddedSocket = new WebSocket(base.replace('http:', 'ws:') + access.path + 'ws?clientId=native');
  t.after(() => embeddedSocket.terminate());
  const [embeddedMessage] = await once(embeddedSocket, 'message'); assert.equal(embeddedMessage.toString(), '/ws?clientId=native');
  assert.ok(requests.every(r => !r.authorization && !r.cookie && !r.url.includes(access.id)));
  const closed = once(embeddedSocket, 'close');
  assert.equal((await fetch(base + '/api/gateway/canvas-access/' + access.id, { method: 'DELETE' })).status, 200);
  await closed;
  assert.equal((await fetch(base + access.path)).status, 401);
});
