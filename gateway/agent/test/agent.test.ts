import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentService } from '../service.js';
import { AgentStore } from '../store.js';
import { ComfyAdapter, ComfyRequestError } from '../../workflow/comfyAdapter.js';
import { canvasToPrompt } from '../../workflow/canvas.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const checkpoint = 'v1-5-pruned-emaonly-fp16.safetensors';
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolCallId: randomUUID(), toolName, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] });
const answer = (text = '已完成并保存工作流。') => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const scripted = (steps: ReturnType<typeof call | typeof answer>[]) => new MockLanguageModelV3({ doGenerate: steps.at(-1)?.content[0]?.type === 'text' ? [...steps, call('finish_response', { answer: (steps.at(-1)!.content[0] as { text: string }).text })] : steps });

class FakeComfy extends ComfyAdapter {
  submits = 0;
  mode: 'success' | 'pending' | 'lost' | 'reject' | 'error_once' = 'success';
  executions: Record<string, any> = {};
  constructor() { super({ comfyUrl: 'http://unused.invalid' }); }
  override async getObjectInfo() { return structuredClone(info); }
  override async submit(prompt: unknown, _info: any, context: any) {
    this.submits++;
    if (this.mode === 'reject') throw new ComfyRequestError(400, { node_errors: { '5': { error: 'bad sampler' } } });
    const promptId = `run-${this.submits}`;
    this.executions[promptId] = { prompt: [this.submits, promptId, prompt, { comfymobile_agent: { attempt_id: context.attemptId } }], status: { completed: true, status_str: this.mode === 'error_once' && this.submits === 1 ? 'error' : 'success', messages: [['execution_error', { node_id: '5', exception_message: 'test failure' }]] }, outputs: { '7': { images: [{ filename: 'sample.png', subfolder: 'Agent', type: 'output' }] } } };
    if (this.mode === 'lost') throw new ComfyRequestError(0, undefined, true);
    return { promptId };
  }
  override async getQueue() { return { queue_running: this.mode === 'pending' ? Object.values(this.executions).map((e: any) => e.prompt) : [], queue_pending: [] }; }
  override async getHistory(promptId: string) { return this.mode === 'pending' ? {} : { [promptId]: this.executions[promptId] }; }
  override async getRecentHistory() { return this.mode === 'pending' ? {} : this.executions; }
}
const config = (path = ':memory:') => ({ agentStorePath: path, comfyUrl: 'http://unused.invalid', agentPollMs: 60_000 });
async function drain(service: AgentService, id: string, limit = 20) {
  for (let i = 0; i < limit; i++) {
    await service.tick();
    if (['completed', 'failed', 'cancelled'].includes(service.store.task(id).state)) return service.store.task(id);
  }
  throw new Error(`Task did not finish: ${JSON.stringify(service.store.task(id))}`);
}

test('AI SDK loop creates, patches, previews and saves; reconnect cursor and disk persistence work', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-mvp-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'agent.sqlite');
  const adapter = new FakeComfy();
  const model = scripted([
    call('inspect_environment', {}),
    call('create_from_template', { checkpoint, text: 'anime portrait' }),
    call('apply_workflow_patch', { baseVersion: 1, summary: '改为竖屏', operations: [{ op: 'set_input', nodeId: '4', input: 'height', value: 768 }] }),
    call('validate_workflow', {}), call('submit_preview', { version: 2 }),
    call('save_workflow_version', { version: 2 }), answer(),
  ]);
  const service = new AgentService(config(path), { model, adapter });
  const session = await service.createSession('alice', '头像');
  const requestId = randomUUID();
  const task = service.enqueue(session.id, 'alice', requestId, '帮我生成竖屏动漫头像并保存');
  assert.equal(service.enqueue(session.id, 'alice', requestId, task.message).id, task.id);
  assert.throws(() => service.enqueue(session.id, 'alice', randomUUID(), 'concurrent'), /当前任务/);
  const completed = await drain(service, task.id);
  assert.equal(completed.state, 'completed', completed.error);
  assert.equal(adapter.submits, 1);
  assert.equal(model.doGenerateCalls.length, 8);
  const version = service.store.version(session.id)!;
  assert.equal(version.version, 2); assert.equal(version.saved, true);
  assert.equal(canvasToPrompt(version.canvas, info)['4'].inputs.height, 768);
  const snapshot = service.snapshot(session.id, 'alice', 0);
  assert.ok(snapshot.events.some(e => e.kind === 'result'));
  assert.equal(service.snapshot(session.id, 'alice', snapshot.cursor).events.length, 0);
  assert.throws(() => service.snapshot(session.id, 'bob', 0), /不存在/);
  assert.ok(!('messages' in snapshot.tasks[0]));
  await service.stop();
  const reopened = new AgentStore(path);
  assert.equal(reopened.version(session.id)!.version, 2);
  assert.equal(reopened.task(task.id).state, 'completed');
  reopened.close();
});

test('execution failure goes back to model for repair and a bounded second preview', async () => {
  const adapter = new FakeComfy(); adapter.mode = 'error_once';
  const model = scripted([
    call('submit_preview', { version: 1 }),
    call('apply_workflow_patch', { baseVersion: 1, summary: '降低步数重试', operations: [{ op: 'set_input', nodeId: '5', input: 'steps', value: 10 }] }),
    call('submit_preview', { version: 2 }), answer(),
  ]);
  const service = new AgentService(config(), { model, adapter });
  try {
    const session = await service.createSession('alice', 'repair', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'alice', randomUUID(), '试跑并修复');
    assert.equal((await drain(service, task.id)).state, 'completed');
    assert.equal(adapter.submits, 2);
    assert.ok(service.snapshot(session.id, 'alice', 0).events.some(e => e.kind === 'execution_error'));
    assert.ok(JSON.stringify(model.doGenerateCalls[1].prompt).includes('test failure'));
  } finally { await service.stop(); }
});

test('lost submit response reconciles completed history without a duplicate submission', async () => {
  const adapter = new FakeComfy(); adapter.mode = 'lost';
  const service = new AgentService(config(), { model: scripted([call('submit_preview', { version: 1 }), answer()]), adapter });
  try {
    const session = await service.createSession('a', 'test', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '生成');
    await service.tick(); assert.equal(service.store.task(task.id).state, 'reconciling');
    assert.equal((await drain(service, task.id)).state, 'completed');
    assert.equal(adapter.submits, 1);
  } finally { await service.stop(); }
});

test('restart resumes existing pending GPU work and retains its original workflow version', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-restart-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite'); const adapter = new FakeComfy(); adapter.mode = 'pending';
  const first = new AgentService(config(path), { model: scripted([call('submit_preview', { version: 1 })]), adapter });
  const session = await first.createSession('a', 'test', textToImage(info, checkpoint, 'test'));
  const task = first.enqueue(session.id, 'a', randomUUID(), '生成');
  await first.tick(); assert.equal(first.store.task(task.id).state, 'waiting_comfy');
  await first.stop();
  adapter.mode = 'success';
  const next = new AgentService(config(path), { model: scripted([answer()]), adapter });
  try {
    next.start();
    assert.equal((await drain(next, task.id)).state, 'completed');
    assert.equal(adapter.submits, 1);
    assert.equal((next.store.task(task.id).result as any).version, 1);
  } finally { await next.stop(); }
});

test('unknown submission outcome stops for reconciliation rather than retrying', async () => {
  const adapter = new FakeComfy(); adapter.mode = 'lost';
  const service = new AgentService(config(), { model: scripted([call('submit_preview', { version: 1 })]), adapter });
  try {
    const session = await service.createSession('a', 'test', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '生成'); await service.tick();
    adapter.executions = {};
    assert.equal((await drain(service, task.id)).state, 'failed');
    assert.equal(adapter.submits, 1);
  } finally { await service.stop(); }
});

test('cancel, version restore and provider-not-configured states', async () => {
  const adapter = new FakeComfy(); adapter.mode = 'pending';
  const service = new AgentService(config(), { model: scripted([call('submit_preview', { version: 1 })]), adapter });
  try {
    const session = await service.createSession('a', 'test', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '生成'); await service.tick();
    assert.throws(() => service.restore(session.id, 'a', 1, 1), /停止/);
    service.cancel(session.id, 'a', task.id); await service.tick();
    assert.equal(service.store.task(task.id).state, 'cancelled');
    assert.equal(adapter.submits, 1);
    assert.equal(service.restore(session.id, 'a', 1, 1).version, 2);
    assert.throws(() => service.restore(session.id, 'a', 1, 1), /版本/);
  } finally { await service.stop(); }
  const unavailable = new AgentService(config());
  try {
    const session = await unavailable.createSession('a', 'empty');
    assert.equal(unavailable.status().providerReady, false);
    assert.throws(() => unavailable.enqueue(session.id, 'a', randomUUID(), 'test'), /provider/);
    assert.equal(unavailable.store.tasks().length, 0);
  } finally { await unavailable.stop(); }
});

test('step limit and preview limit prevent unbounded agent execution', async () => {
  const adapter = new FakeComfy();
  const service = new AgentService({ ...config(), agentMaxSteps: 3, agentMaxPreviews: 1 }, { model: scripted([call('submit_preview', { version: 1 }), call('submit_preview', { version: 1 }), call('get_workflow', {})]), adapter });
  try {
    const session = await service.createSession('a', 'test', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '生成');
    assert.equal((await drain(service, task.id)).state, 'failed');
    assert.equal(adapter.submits, 1);
    assert.equal(service.store.task(task.id).steps, 3);
  } finally { await service.stop(); }
});


test('a text-only promise is reviewed and requested preview actually executes before completion', async () => {
  const adapter = new FakeComfy();
  const model = scripted([answer('好的，使用版本 1 提交预览。'), call('submit_preview', {version:1}), answer('预览已成功完成。')]);
  const service = new AgentService(config(), {model,adapter});
  try {
    const session = await service.createSession('a','completion',textToImage(info,checkpoint,'test'));
    const task = service.enqueue(session.id,'a',randomUUID(),'现在实际预览一次');
    await service.tick();
    assert.equal(service.store.task(task.id).state,'queued');
    assert.ok(!service.snapshot(session.id,'a',0).events.some(e=>e.kind==='assistant'));
    assert.equal((await drain(service,task.id)).state,'completed');
    assert.equal(adapter.submits,1);
    assert.ok(service.snapshot(session.id,'a',0).events.some(e=>e.kind==='result'));
    assert.ok(JSON.stringify(model.doGenerateCalls[1].prompt).includes('现在实际预览一次'));
    assert.deepEqual(model.doGenerateCalls[1].toolChoice, {type:'required'});
  } finally {await service.stop();}
});

test('a provider ignoring required completion tool calls cannot silently mark a task complete', async () => {
  const adapter = new FakeComfy();
  const model = new MockLanguageModelV3({doGenerate:[answer('我将执行。'),answer('现在就执行。')]});
  const service = new AgentService(config(),{model,adapter});
  try {
    const session=await service.createSession('a','ignored-tools',textToImage(info,checkpoint,'test'));
    const task=service.enqueue(session.id,'a',randomUUID(),'预览一次');
    const result=await drain(service,task.id);
    assert.equal(result.state,'failed');assert.match(result.error!,/模型/);assert.equal(adapter.submits,0);
  } finally {await service.stop();}
});

test('transcript tool lifecycle includes read tools, failures and stable receipt IDs', async () => {
  const model=scripted([call('inspect_environment',{}),call('submit_preview',{version:99}),answer('该版本不存在。')]);
  const service=new AgentService(config(),{model,adapter:new FakeComfy()});
  try {
    const session=await service.createSession('alice','transcript');
    const task=service.enqueue(session.id,'alice',randomUUID(),'检查环境');
    await drain(service,task.id);
    const events=service.snapshot(session.id,'alice',0).events;
    const starts=events.filter(e=>e.kind==='tool_started');const finishes=events.filter(e=>e.kind==='tool_finished');
    assert.equal(starts.length,2);assert.equal(finishes.length,2);
    assert.deepEqual(starts.map(e=>e.data.callId),finishes.map(e=>e.data.callId));
    assert.equal(finishes[0].data.isError,false);assert.equal(finishes[1].data.isError,true);
    assert(!JSON.stringify(starts).includes('checkpoints'));
  } finally {await service.stop()}
});

test('replayed mutation call IDs reuse receipts and preserve a matched tool lifecycle', async () => {
  const creation=call('create_from_template',{checkpoint,text:'receipt demo'});
  const service=new AgentService(config(),{model:scripted([creation,creation,answer()]),adapter:new FakeComfy()});
  try {
    const session=await service.createSession('alice','receipt');
    const task=service.enqueue(session.id,'alice',randomUUID(),'创建工作流');
    await drain(service,task.id);
    const events=service.snapshot(session.id,'alice',0).events;
    assert.equal(service.store.version(session.id)!.version,1);
    assert.equal(events.filter(e=>e.kind==='workflow').length,1);
    const starts=events.filter(e=>e.kind==='tool_started');const finishes=events.filter(e=>e.kind==='tool_finished');
    assert.equal(starts.length,2);assert.equal(finishes.length,2);
    assert.equal(new Set(starts.map(e=>e.data.callId)).size,1);
    assert(finishes.every(e=>!e.data.isError));
  } finally {await service.stop()}
});

test('history lists a bounded first-message preview without crossing device ownership', async () => {
  const service=new AgentService(config(),{model:scripted([answer()]),adapter:new FakeComfy()});
  try {
    const alice=await service.createSession('alice','New workflow');
    const bob=await service.createSession('bob','New workflow');
    service.enqueue(alice.id,'alice',randomUUID(),'A paper boat at sunrise');
    service.enqueue(bob.id,'bob',randomUUID(),'Private request');
    const list=service.store.list('alice');
    assert.equal(list.length,1);assert.equal(list[0].preview,'A paper boat at sunrise');
    assert(!JSON.stringify(list).includes('Private request'));
  } finally {await service.stop()}
});
