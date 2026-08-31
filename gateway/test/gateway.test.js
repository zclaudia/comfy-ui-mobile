import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { loadGatewayConfig } from '../config.js';
import { createDeviceStore } from '../deviceStore.js';
import { createGatewayServer } from '../server.js';

const AUTH_TOKEN = 'test-gateway-token-with-enough-entropy';

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    resolve(server.address());
  });
});

const close = (server) => new Promise((resolve, reject) => {
  server.closeAllConnections?.();
  server.close((error) => (error ? reject(error) : resolve()));
});

const openWebSocket = (url, options) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url, options);
  const timeout = setTimeout(() => reject(new Error('WebSocket timed out')), 3000);
  socket.once('open', () => {
    clearTimeout(timeout);
    resolve(socket);
  });
  socket.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
});

test('Gateway protects allowlisted HTTP routes and proxies authenticated requests', async (t) => {
  let upstreamHeaders = null;
  const upstream = http.createServer((request, response) => {
    upstreamHeaders = request.headers;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ path: request.url, upstream: true }));
  });
  const upstreamAddress = await listen(upstream);
  t.after(() => close(upstream));

  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-gateway-test-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<main>mobile ui</main>');
  t.after(() => fs.rmSync(staticDir, { recursive: true, force: true }));

  const config = {
    ...loadGatewayConfig({
      COMFYUI_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      GATEWAY_AUTH_TOKEN: AUTH_TOKEN,
      GATEWAY_SESSION_SECRET: 'test-session-secret-with-enough-entropy',
      GATEWAY_STATIC_DIR: staticDir,
      GATEWAY_DEVICE_STORE: path.join(staticDir, 'devices.json'),
    }),
    host: '127.0.0.1',
    port: 0,
  };
  const gateway = createGatewayServer(config);
  const gatewayAddress = await gateway.start();
  t.after(() => gateway.stop());
  const baseUrl = `http://127.0.0.1:${gatewayAddress.port}`;

  const health = await fetch(`${baseUrl}/api/gateway/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).authenticationRequired, true);

  const unauthenticated = await fetch(`${baseUrl}/system_stats`);
  assert.equal(unauthenticated.status, 401);

  const rejectedLogin = await fetch(`${baseUrl}/api/gateway/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  });
  assert.equal(rejectedLogin.status, 401);

  const malformedLogin = await fetch(`${baseUrl}/api/gateway/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  assert.equal(malformedLogin.status, 400);
  assert.equal((await malformedLogin.json()).error, 'invalid_json');

  const login = await fetch(`${baseUrl}/api/gateway/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_TOKEN, remember: true }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok(cookie.startsWith('comfy_mobile_session='));

  const registration = await fetch(`${baseUrl}/api/gateway/devices/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_TOKEN, deviceName: 'Test Android' }),
  });
  assert.equal(registration.status, 201);
  const registrationBody = await registration.json();
  assert.match(registrationBody.deviceToken, /^cmdt_/);
  assert.equal(registrationBody.device.name, 'Test Android');

  const deviceStoreContents = fs.readFileSync(config.deviceStorePath, 'utf8');
  assert.equal(deviceStoreContents.includes(registrationBody.deviceToken), false);

  const listedDevices = await fetch(`${baseUrl}/api/gateway/devices`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  assert.equal(listedDevices.status, 200);
  assert.deepEqual((await listedDevices.json()).devices, [registrationBody.device]);

  const proxied = await fetch(`${baseUrl}/system_stats`, {
    headers: {
      Authorization: `Bearer ${registrationBody.deviceToken}`,
    },
  });
  assert.equal(proxied.status, 200);
  assert.deepEqual(await proxied.json(), { path: '/system_stats', upstream: true });
  assert.equal(upstreamHeaders.cookie, undefined);
  assert.equal(upstreamHeaders.authorization, undefined);

  const dangerous = await fetch(`${baseUrl}/comfymobile/api/reboot`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(dangerous.status, 403);
  assert.equal((await dangerous.json()).error, 'dangerous_action_disabled');

  const notAllowed = await fetch(`${baseUrl}/arbitrary-upstream-path`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(notAllowed.status, 404);

  const blockedTokenEndpoint = await fetch(`${baseUrl}/comfymobile/api/auth/token`, {
    headers: { Cookie: cookie },
  });
  assert.equal(blockedTokenEndpoint.status, 404);
  assert.equal((await blockedTokenEndpoint.json()).error, 'route_not_allowed');

  const revoke = await fetch(
    `${baseUrl}/api/gateway/devices/${encodeURIComponent(registrationBody.device.id)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    },
  );
  assert.equal(revoke.status, 200);
  assert.ok((await revoke.json()).device.revokedAt);

  const revokedRequest = await fetch(`${baseUrl}/system_stats`, {
    headers: { Authorization: `Bearer ${registrationBody.deviceToken}` },
  });
  assert.equal(revokedRequest.status, 401);

  const spa = await fetch(`${baseUrl}/settings/server`);
  assert.equal(spa.status, 200);
  assert.equal(await spa.text(), '<main>mobile ui</main>');
});

test('Gateway proxies a Bearer-authenticated native ComfyUI WebSocket', async (t) => {
  const upstreamHttp = http.createServer();
  const upstreamWs = new WebSocketServer({ noServer: true });
  upstreamHttp.on('upgrade', (request, socket, head) => {
    if (!request.url.startsWith('/ws?')) {
      socket.destroy();
      return;
    }
    upstreamWs.handleUpgrade(request, socket, head, (client) => {
      client.send(JSON.stringify({ type: 'status', data: { upstream: true } }));
    });
  });
  const upstreamAddress = await listen(upstreamHttp);
  t.after(async () => {
    upstreamWs.clients.forEach((client) => client.terminate());
    upstreamWs.close();
    await close(upstreamHttp);
  });

  const deviceStoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-gateway-ws-test-'));
  t.after(() => fs.rmSync(deviceStoreDir, { recursive: true, force: true }));
  const config = {
    ...loadGatewayConfig({
      COMFYUI_URL: `http://127.0.0.1:${upstreamAddress.port}`,
      GATEWAY_AUTH_TOKEN: AUTH_TOKEN,
      GATEWAY_SESSION_SECRET: 'test-session-secret-with-enough-entropy',
      GATEWAY_STATIC_DIR: path.join(os.tmpdir(), 'does-not-exist'),
      GATEWAY_DEVICE_STORE: path.join(deviceStoreDir, 'devices.json'),
    }),
    host: '127.0.0.1',
    port: 0,
  };
  const gateway = createGatewayServer(config);
  const gatewayAddress = await gateway.start();
  t.after(() => gateway.stop());
  const baseUrl = `http://127.0.0.1:${gatewayAddress.port}`;

  const registration = await fetch(`${baseUrl}/api/gateway/devices/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: AUTH_TOKEN, deviceName: 'WebSocket Android' }),
  });
  assert.equal(registration.status, 201);
  const { deviceToken } = await registration.json();

  const socket = await openWebSocket(
    `ws://127.0.0.1:${gatewayAddress.port}/ws?clientId=test-client`,
    { headers: { Authorization: `Bearer ${deviceToken}` } },
  );
  t.after(() => socket.terminate());

  const message = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('No proxied message received')), 3000);
    socket.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(data.toString()));
    });
  });
  assert.deepEqual(message, { type: 'status', data: { upstream: true } });

  const selfRevoke = await fetch(`${baseUrl}/api/gateway/device`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(selfRevoke.status, 200);

  const revokedRequest = await fetch(`${baseUrl}/system_stats`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  assert.equal(revokedRequest.status, 401);
});

test('Device credentials survive Gateway restarts and remain revocable', async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-device-store-test-'));
  const deviceStorePath = path.join(storeDir, 'devices.json');
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const config = {
    deviceStorePath,
    deviceTokenTtlSeconds: 24 * 60 * 60,
  };

  const initialStore = createDeviceStore(config);
  const registration = await initialStore.register('Persistent Android');
  assert.equal(initialStore.authenticate(registration.token), true);

  const reloadedStore = createDeviceStore(config);
  assert.equal(reloadedStore.authenticate(registration.token), true);
  await reloadedStore.revoke(registration.device.id);

  const revokedStore = createDeviceStore(config);
  assert.equal(revokedStore.authenticate(registration.token), false);
  assert.equal(fs.statSync(deviceStorePath).mode & 0o777, 0o600);
});
