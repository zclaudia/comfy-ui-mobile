import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentModels, modelInput } from '../models.js';
import { AgentStore } from '../store.js';
import { AgentService } from '../../dist/agent/service.js';
import { createGatewayServer } from '../../server.js';
import { loadGatewayConfig } from '../../config.js';
import { info } from './fixture.js';

const profile = { name: '助手', model: 'example-model', baseUrl: 'http://unused.invalid/v1', apiKey: 'private-test-key', contextWindow: 32768, maxOutputTokens: 2500, vision: false };

test('model profiles survive restart, redact secrets, retain/clear keys, and protect endpoints and active tasks', () => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-models-'));
  const path = join(folder, 'agent.sqlite');
  try {
    let store = new AgentStore(path);
    let models = new AgentModels(store, profile);
    const first = models.list().models[0];
    assert.equal(first.hasApiKey, true);
    assert.ok(!JSON.stringify(models.list()).includes(profile.apiKey));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const { apiKey: _, ...noKey } = profile;
    models.save({ ...noKey, vision: true }, first.id);
    assert.equal(models.get(first.id)?.apiKey, profile.apiKey);
    assert.throws(() => models.save({ ...noKey, baseUrl: 'https://other.invalid/v1' }, first.id), /重新填写密钥/);
    assert.throws(() => models.save({ ...noKey, baseUrl: 'https://user:password@other.invalid/v1' }, first.id));
    const session = store.create('owner', 'test');
    const task = store.enqueue(session.id, randomUUID(), 'hello', 10000, [], first.id);
    assert.throws(() => models.remove(first.id), /运行中的任务/);
    assert.throws(() => models.save(noKey, first.id), /运行中的任务/);
    const second = models.save({ ...noKey, name: 'another' });
    models.activate(second.id);
    assert.equal(store.task(task.id).modelId, first.id);
    task.state = 'completed'; store.update(task);
    models.save({ ...noKey, apiKey: '' }, first.id);
    assert.equal(models.get(first.id)?.apiKey, '');
    store.close();
    store = new AgentStore(path); models = new AgentModels(store, { ...profile, name: 'changed environment' });
    assert.equal(models.list().activeId, second.id);
    assert.equal(models.list().models.length, 2, 'environment does not overwrite managed settings');
    models.remove(second.id);
    assert.equal(models.list().activeId, first.id);
    models.remove(first.id);
    store.close();
    store = new AgentStore(path); models = new AgentModels(store, profile);
    assert.equal(models.list().models.length, 0, 'deleted environment profile is not resurrected');
    store.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('model capability schema rejects invalid windows, output budgets, URLs and credentials in model IDs', () => {
  for (const patch of [{ contextWindow: 1000 }, { contextWindow: 8192.5 }, { maxOutputTokens: 9000 }, { vision: 'yes' }, { baseUrl: 'file:///private/key' }, { baseUrl: 'https://api.invalid/v1?key=secret' }, { model: 'sk-secret' }]) {
    assert.equal(modelInput.safeParse({ ...profile, ...patch }).success, false);
  }
});

test('authenticated App model routes configure a running provider without restart; status and chat honor capabilities', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-model-routes-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const requests: any[] = [];
  const provider = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/object_info') { response.end(JSON.stringify(info)); return; }
    if (request.url?.startsWith('/comfymobile/api/files/list')) { response.end(JSON.stringify({ status: 'success', images: [], videos: [], files: [] })); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const review = body.tool_choice === 'required';
    response.end(JSON.stringify({ id: 'test-completion', object: 'chat.completion', created: 0, model: body.model, choices: [{ index: 0,
      message: review ? { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'finish_response', arguments: '{"answer":"已配置并连通。"}' } }] } : { role: 'assistant', content: '已配置并连通。' },
      finish_reason: review ? 'tool_calls' : 'stop',
    }], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => provider.close(e => e ? reject(e) : resolve())));
  const providerUrl = `http://127.0.0.1:${(provider.address() as any).port}`;
  const token = 'test-model-management-auth-token';
  const config = { ...loadGatewayConfig({ GATEWAY_AUTH_TOKEN: token, GATEWAY_DEVICE_STORE: join(folder, 'devices.json'), GATEWAY_STATIC_DIR: folder }),
    host: '127.0.0.1', port: 0, comfyUrl: providerUrl, agentStorePath: join(folder, 'agent.sqlite'), agentPollMs: 60000 };
  const service = new AgentService(config);
  const gateway = createGatewayServer(config, { agentService: service });
  const address = await gateway.start();
  t.after(() => gateway.stop());
  const url = `http://127.0.0.1:${address.port}/api/gateway/agent`;
  const call = (path: string, method = 'GET', body?: unknown, auth = token) => fetch(url + path, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call('/models', 'GET', undefined, '')).status, 401);
  assert.equal((await call('/models', 'POST', profile, '')).status, 401);
  assert.equal((await call('/models', 'POST', { ...profile, contextWindow: 1 })).status, 400);
  const created = await call('/models', 'POST', { ...profile, baseUrl: `${providerUrl}/v1`, maxOutputTokens: 1000 });
  assert.equal(created.status, 201);
  const model = (await created.json()).model;
  assert.equal(model.apiKey, undefined);
  const status = await (await call('/status')).json();
  assert.equal(status.providerReady, true);
  assert.equal(status.vision, false);
  assert.equal(status.contextWindow, 32768);
  const session = (await (await call('/sessions', 'POST', { name: 'managed model' })).json()).session;
  const sent = await call(`/sessions/${session.id}/messages`, 'POST', { requestId: randomUUID(), message: 'hello', attachments: [{ filename: 'ref.png', kind: 'image' }] });
  assert.equal(sent.status, 202);
  const taskId = (await sent.json()).taskId;
  for (let i = 0; i < 4; i++) await service.tick();
  assert.equal(service.store.task(taskId).state, 'completed');
  assert.equal(requests.length, 2, 'production provider is invoked after configuring it through HTTP');
  assert.ok(requests.every(r => r.model === profile.model && r.max_tokens === 1000));
  assert.ok(!JSON.stringify(requests).includes('image_url'), 'vision disabled sends paths only');
  const snapshots = await Promise.all(['/status', '/models', `/sessions/${session.id}`].map(async p => (await call(p)).text()));
  assert.ok(snapshots.every(value => !value.includes(profile.apiKey)));
  assert.equal((await call(`/models/${model.id}`, 'PUT', { ...profile, baseUrl: `${providerUrl}/v1`, vision: true })).status, 200);
  assert.equal((await (await call('/status')).json()).vision, true);
  assert.equal((await call(`/models/${model.id}`, 'DELETE')).status, 200);
  assert.equal((await (await call('/status')).json()).providerReady, false);
});
