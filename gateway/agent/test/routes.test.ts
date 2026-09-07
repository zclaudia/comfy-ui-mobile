import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayServer } from '../../server.js';
import { loadGatewayConfig } from '../../config.js';
import { AgentService } from '../../dist/agent/service.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

test('real Gateway agent routes enforce auth, cross-device session sharing, payload validation and version access', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-routes-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const token = 'route-test-admin-token-long-enough';
  const config = { ...loadGatewayConfig({ GATEWAY_AUTH_TOKEN: token, GATEWAY_DEVICE_STORE: join(folder, 'devices.json'), GATEWAY_STATIC_DIR: folder }), host: '127.0.0.1', port: 0 };
  const agent = new AgentService({ ...config, agentStorePath: join(folder, 'agent.sqlite') });
  const gateway = createGatewayServer(config, { agentService: agent });
  const address = await gateway.start();
  t.after(() => gateway.stop());
  const base = `http://127.0.0.1:${address.port}`;
  const request = (path: string, body?: unknown, auth = token) => fetch(`${base}/api/gateway${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await request('/agent/status', undefined, '')).status, 401);
  assert.equal((await (await request('/agent/status')).json()).providerReady, false);
  const login = await fetch(`${base}/api/gateway/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const canvas = textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'test');
  const create = await request('/agent/sessions', { name: 'test', canvas });
  assert.equal(create.status, 201);
  const session = (await create.json()).session;
  assert.equal((await fetch(`${base}/api/gateway/agent/sessions/${session.id}`, { headers: { Cookie: cookie } })).status, 200);
  const registration = await request('/devices/register', { token, deviceName: 'test-device' });
  const device = (await registration.json()).deviceToken;
  // A device is enrolled with the setup token, so it is the same person: it reads and continues the browser's sessions.
  assert.equal((await request(`/agent/sessions/${session.id}`, undefined, device)).status, 200);
  assert.equal((await request(`/agent/sessions/${session.id}/versions/1`, undefined, device)).status, 200);
  assert((await (await request('/agent/sessions', undefined, device)).json()).sessions.some((s: { id: string }) => s.id === session.id), 'device lists the browser session');
  assert.equal((await request(`/agent/sessions/${session.id}/versions/1`)).status, 200);
  assert.equal((await request(`/agent/sessions/${session.id}/save`, { version: 1 })).status, 200);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: 'test' })).status, 503);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: 'test', owner: 'somebody' })).status, 400);
  // Attachment validation runs before the provider check: a valid attachment-only message reaches the 503, invalid ones stop at 400.
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), attachments: [{ filename: 'ref.png', subfolder: 'agent', kind: 'image' }] })).status, 503);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: '' })).status, 400);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: 'x', attachments: [{ filename: '../etc/passwd', kind: 'image' }] })).status, 400);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: 'x', attachments: [{ filename: 'a.png', subfolder: '../models', kind: 'image' }] })).status, 400);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: 'x', attachments: [{ filename: 'a.png', type: 'output', kind: 'image' }] })).status, 400);
  assert.equal((await request(`/agent/sessions/${session.id}/messages`, { requestId: randomUUID(), message: 'x', attachments: Array.from({ length: 9 }, (_, i) => ({ filename: `${i}.png`, kind: 'image' })) })).status, 400);
  assert.equal((await request('/agent/sessions', { name: 'bad', canvas: { ...canvas, nodes: [{ ...canvas.nodes[0], mode: 4 }] } })).status, 422);
  assert.equal((await request(`/agent/sessions/${session.id}?after=-1`)).status, 400);
  assert.equal((await request(`/agent/sessions/${session.id}/versions/9999`)).status, 404);
  assert.equal((await request(`/agent/sessions/${session.id}/restore`, { version: 1, baseVersion: 0 })).status, 409);
  const response = await request(`/agent/sessions/${session.id}`);
  const data = await response.json();
  assert.equal(data.versions[0].saved, true);
  assert.equal(data.tasks.length, 0);
  assert.equal((await request(`/agent/sessions/${session.id}/restore`, { version: 1, baseVersion: 1 }, device)).status, 200);

  const call = (method: string, path: string, body?: unknown, auth = token) => fetch(`${base}/api/gateway${path}`, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const boundCreate = await request('/agent/sessions', { name: 'ignored', canvas, workflow: { id: 'wf-1', name: '海报', filename: '海报.json' } });
  assert.equal(boundCreate.status, 201);
  const bound = (await boundCreate.json()).session;
  assert.equal(bound.name, '海报');
  const listed = (await (await request('/agent/sessions')).json()).sessions.find((s: any) => s.id === bound.id);
  assert.deepEqual(listed.workflow, { id: 'wf-1', name: '海报', filename: '海报.json' });
  assert.equal(listed.active, false);
  assert.equal(typeof listed.lastActivity, 'number');
  assert.equal((await call('PATCH', `/agent/sessions/${bound.id}`, { workflow: null }, device)).status, 200);
  assert.equal((await call('PATCH', `/agent/sessions/${bound.id}`, { owner: 'x' })).status, 400);
  const patched = await call('PATCH', `/agent/sessions/${bound.id}`, { name: '新名字', workflow: null });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).session.workflow, undefined);
  const imported = await call('POST', `/agent/sessions/${bound.id}/versions`, { canvas, baseVersion: 1, summary: '画布修改' });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).version, 2);
  assert.equal((await call('POST', `/agent/sessions/${bound.id}/versions`, { canvas, baseVersion: 1 })).status, 409);
  assert.equal((await call('POST', `/agent/sessions/${bound.id}/versions`, { canvas: { ...canvas, nodes: [{ ...canvas.nodes[0], mode: 4 }] }, baseVersion: 2 })).status, 422);
  assert.equal((await call('DELETE', `/agent/sessions/${bound.id}`, undefined, device)).status, 200);
  assert.equal((await call('DELETE', `/agent/sessions/${bound.id}`)).status, 404);
  assert.equal((await request(`/agent/sessions/${bound.id}`)).status, 404);
});

test('HTTP clients receive actionable failures and can recover without losing workflow versions', async t => {
  const { MockLanguageModelV3 } = await import('ai/test');
  const { ComfyAdapter } = await import('../../dist/workflow/comfyAdapter.js');
  const folder = mkdtempSync(join(tmpdir(), 'agent-http-failure-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const token = 'isolated-agent-fault-test-token';
  const config = { ...loadGatewayConfig({ GATEWAY_AUTH_TOKEN: token, GATEWAY_DEVICE_STORE: join(folder, 'devices.json'), GATEWAY_STATIC_DIR: folder }), host: '127.0.0.1', port: 0, agentPollMs: 20, agentStorePath: join(folder, 'agent.sqlite') };
  let mode: 'provider-error' | 'success' | 'empty' | 'comfy-error' = 'provider-error';
  let calls = 0;
  const marker = 'TEST_ONLY_PRIVATE_PROVIDER_DETAIL';
  const model = new MockLanguageModelV3({ doGenerate: async (options) => {
    calls++;
    if (mode === 'provider-error') throw new Error(`401 ${marker}`);
    return { content: mode === 'empty' ? [] : options.toolChoice?.type === 'required' ? [{type:'tool-call' as const, toolCallId:randomUUID(),toolName:'finish_response',input:JSON.stringify({answer:'连接已恢复。'})}] : [{ type: 'text' as const, text: '连接已恢复。' }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } }, warnings: [] };
  } });
  class Adapter extends ComfyAdapter {
    override async getObjectInfo() { if (mode === 'comfy-error') throw new Error(marker); return structuredClone(info); }
  }
  const agent = new AgentService(config, { model, adapter: new Adapter({ comfyUrl: 'http://unused.invalid' }) });
  const gateway = createGatewayServer(config, { agentService: agent });
  const address = await gateway.start();
  t.after(() => gateway.stop());
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/gateway/agent${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    assert.ok(response.ok, `HTTP ${response.status}`); return response.json();
  };
  const canvas = textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'test');
  const {session} = await request('/sessions', {name:'isolated-faults',canvas});
  await request(`/sessions/${session.id}/save`,{version:1});
  const submit = () => request(`/sessions/${session.id}/messages`,{requestId:randomUUID(),message:'解释当前工作流，不执行'});
  const wait = async (taskId: string) => {
    for(let i=0;i<100;i++) {
      const snap=await request(`/sessions/${session.id}`);
      const task=snap.tasks.find((item:any)=>item.id===taskId);
      if(['failed','completed'].includes(task?.state)) return {snap,task};
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    throw new Error('fault scenario did not terminate');
  };
  await t.test('provider auth/network errors are redacted and not automatically retried',async()=>{
    const {taskId}=await submit();const {snap,task}=await wait(taskId);
    assert.equal(task.state,'failed'); assert.match(task.error,/请求失败/);
    assert.ok(!JSON.stringify(snap).includes(marker));assert.equal(calls,1);
    await new Promise(resolve=>setTimeout(resolve,80));assert.equal(calls,1);
    assert.equal(snap.session.version,1);assert.equal(snap.versions[0].saved,true);
  });
  await t.test('new message succeeds after provider recovery',async()=>{
    mode='success';const {taskId}=await submit();assert.equal((await wait(taskId)).task.state,'completed');
  });
  await t.test('empty provider response is a visible failure',async()=>{
    mode='empty';const {taskId}=await submit();assert.match((await wait(taskId)).task.error,/有效回答/);
  });
  await t.test('ComfyUI outage is reported without calling the model or changing the workflow',async()=>{
    mode='comfy-error';const before=calls;const {taskId}=await submit();const {snap,task}=await wait(taskId);
    assert.equal(task.state,'failed');assert.equal(calls,before);assert.ok(!JSON.stringify(snap).includes(marker));
    assert.deepEqual((await request(`/sessions/${session.id}/versions/1`)).canvas,canvas);
  });
  await t.test('expired task stops before any model call',async()=>{
    mode='success';const before=calls;
    const task=agent.enqueue(session.id,'administrator',randomUUID(),'expiry');
    task.deadline=Date.now()-1;agent.store.update(task);
    const result=await wait(task.id);assert.equal(result.task.state,'failed');assert.match(result.task.error,/耗时上限/);assert.equal(calls,before);
  });
});
