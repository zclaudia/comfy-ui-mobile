import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MockLanguageModelV3 } from 'ai/test';
import { APICallError } from 'ai';
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
  files: Record<string, { bytes: Uint8Array; mediaType: string }> = {};
  fileReads = 0;
  override async getFile(ref: { filename: string; subfolder: string; type: string }) {
    this.fileReads++;
    const file = this.files[`${ref.type}/${ref.subfolder}/${ref.filename}`];
    if (!file) throw new ComfyRequestError(404, undefined);
    return file;
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
    assert.throws(() => unavailable.enqueue(session.id, 'a', randomUUID(), 'test'), /配置助手模型/);
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

test('tool events carry the arguments and result the transcript expands', async () => {
  const model=scripted([call('inspect_environment',{}),call('get_node_schema',{name:'KSampler'}),answer('ok')]);
  const service=new AgentService(config(),{model,adapter:new FakeComfy()});
  try {
    const session=await service.createSession('alice','payloads');
    const task=service.enqueue(session.id,'alice',randomUUID(),'检查环境');
    await drain(service,task.id);
    const events=service.snapshot(session.id,'alice',0).events;
    const starts=events.filter(e=>e.kind==='tool_started');const finishes=events.filter(e=>e.kind==='tool_finished');
    assert.deepEqual(starts.map(e=>e.data.args),[{},{name:'KSampler'}]);
    // A tool that takes no arguments is still worth expanding, so its result rides the finish event.
    assert(finishes.every(e=>e.data.result!==undefined));
    assert(JSON.stringify(finishes[0].data.result).includes('checkpoints'));
  } finally {await service.stop()}
});

test('an oversized tool payload degrades to a truncated string instead of bloating every replay', async () => {
  const service=new AgentService(config(),{model:scripted([call('create_from_template',{checkpoint,text:'x'.repeat(6000)}),answer()]),adapter:new FakeComfy()});
  try {
    const session=await service.createSession('alice','truncation');
    const task=service.enqueue(session.id,'alice',randomUUID(),'创建工作流');
    await drain(service,task.id);
    const start=service.snapshot(session.id,'alice',0).events.find(e=>e.kind==='tool_started')!;
    assert.equal(typeof start.data.args,'string');
    assert.match(start.data.args as string,/… \[truncated\]$/);
    assert((start.data.args as string).length<4200);
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

test('uploaded images reach the model as image parts only while vision is enabled, and never persist into task messages', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const attachments = [
    { filename: 'ref.png', subfolder: 'agent-chat', type: 'input' as const, kind: 'image' as const },
    { filename: 'missing.png', subfolder: 'agent-chat', type: 'input' as const, kind: 'image' as const },
    { filename: 'clip.mp4', subfolder: 'agent-chat', type: 'input' as const, kind: 'video' as const },
  ];
  // The trailing user message is the system-generated session state; the request with the pictures sits before it.
  const userParts = (model: MockLanguageModelV3, step: number) => {
    const user = model.doGenerateCalls[step].prompt.filter(m => m.role === 'user' && !(m.content[0]?.type === 'text' && m.content[0].text.startsWith('[Session state'))).at(-1)!;
    return Array.isArray(user.content) ? user.content : [];
  };
  for (const vision of [true, false]) {
    const adapter = new FakeComfy();
    adapter.files['input/agent-chat/ref.png'] = { bytes: png, mediaType: 'image/png' };
    const model = scripted([call('inspect_environment', {}), answer('看到了参考图。')]);
    const service = new AgentService({ ...config(), agentVision: vision }, { model, adapter });
    assert.equal(service.status().vision, vision);
    const session = await service.createSession('a', '视觉');
    const task = service.enqueue(session.id, 'a', randomUUID(), '按这张图的风格再画一张', attachments);
    const done = await drain(service, task.id);
    assert.equal(done.state, 'completed', done.error);
    const first = userParts(model, 0);
    const images = first.filter(p => p.type === 'file');
    const text = first.find(p => p.type === 'text') as { text: string } | undefined;
    if (vision) {
      assert.equal(images.length, 1, 'the readable PNG is attached; the missing file and the video are skipped');
      assert.equal((images[0] as { mediaType: string }).mediaType, 'image/png');
      assert.match(text!.text, /agent-chat\/ref\.png/, 'the path reference stays alongside the pixels');
      assert.equal(adapter.fileReads, 2, 'each image is fetched once per task, not once per step');
      assert.ok(userParts(model, 1).some(p => p.type === 'file'), 'later steps of the same task still see the image');
    } else {
      assert.equal(images.length, 0);
      assert.equal(adapter.fileReads, 0);
    }
    for (const message of service.store.task(task.id).messages) {
      if (message.role !== 'user') continue;
      assert.equal(typeof message.content, 'string', 'persisted task messages carry only the text form');
    }
  }
});

test('sessions recorded under a per-device namespace are adopted so every client sees them', async () => {
  const dir=mkdtempSync(join(tmpdir(),'agent-adopt-'));
  const path=join(dir,'agent.sqlite');
  try {
    const seed=new AgentStore(path);
    const mine=seed.create('administrator','browser chat');
    const phone=seed.create('device:aaa','phone chat');
    const stranded=seed.create('device:rotated-away','stranded chat');
    seed.close();

    const service=new AgentService({...config(path)},{model:scripted([answer()]),adapter:new FakeComfy()});
    try {
      // Every authenticated client resolves to the one shared namespace, so all three are now listed together.
      const listed=service.store.list('administrator').map(s=>s.id).sort();
      assert.deepEqual(listed,[mine.id,phone.id,stranded.id].sort());
      // The owner inside the stored document moves too, so reads that check it do not 404.
      assert.equal(service.store.session(phone.id,'administrator').owner,'administrator');
      assert.equal(service.store.session(stranded.id,'administrator').owner,'administrator');
      assert.equal(service.store.adoptLegacyDeviceSessions(),0,'adoption is idempotent');
    } finally {await service.stop()}
  } finally {rmSync(dir,{recursive:true,force:true})}
});

const withProfile = (overrides: Record<string, unknown> = {}, path = ':memory:') => ({ ...config(path), agentBaseUrl: 'http://unused.invalid/v1', agentModel: 'unit-model', agentRetryDelayMs: 0, ...overrides });
const rateLimited = () => new APICallError({ message: 'rate limited', url: 'http://unused.invalid/v1/chat/completions', requestBodyValues: {}, statusCode: 429 });

test('the system prompt and tool schemas are byte-identical across steps; per-step state rides in a trailing message', async () => {
  const adapter = new FakeComfy();
  const model = scripted([call('get_workflow', {}), call('apply_workflow_patch', { baseVersion: 1, summary: '改高度', operations: [{ op: 'set_input', nodeId: '4', input: 'height', value: 768 }] }), answer()]);
  const service = new AgentService(config(), { model, adapter });
  try {
    const session = await service.createSession('a', 'cache', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '改成竖屏');
    assert.equal((await drain(service, task.id)).state, 'completed');
    const calls = model.doGenerateCalls;
    assert.ok(calls.length >= 3);
    const system = (call: (typeof calls)[number]) => call.prompt.filter(m => m.role === 'system').map(m => m.content).join('\n');
    const tools = (call: (typeof calls)[number]) => JSON.stringify(call.tools);
    for (let i = 1; i < 3; i++) {
      assert.equal(system(calls[i]), system(calls[0]), `step ${i} system prompt changed`);
      assert.equal(tools(calls[i]), tools(calls[0]), `step ${i} tool schemas changed`);
    }
    assert.ok(!system(calls[0]).includes('Remaining model calls'), 'volatile counters must not live in the cached prefix');
    const last = (call: (typeof calls)[number]) => { const m = call.prompt.at(-1)!; return m.role === 'user' && m.content[0]?.type === 'text' ? m.content[0].text : ''; };
    assert.match(last(calls[0]), /^\[Session state/);
    assert.match(last(calls[0]), /Current session version: 1/);
    assert.match(last(calls[2]), /Current session version: 2/, 'state message reflects the version after the patch');
    assert.match(last(calls[0]), /Remaining model calls: \d+/);
    // The state message is rebuilt each step, never persisted into the task history.
    assert.ok(!JSON.stringify(service.store.task(task.id).messages).includes('[Session state'));
  } finally { await service.stop(); }
});

test('profiles can switch the completion audit off so a text-only answer completes in one call', async () => {
  const adapter = new FakeComfy();
  const model = new MockLanguageModelV3({ doGenerate: [answer('已改好。')] });
  const service = new AgentService(withProfile(), { model, adapter });
  try {
    const id = service.models.get()!.id;
    assert.equal(service.models.list().models[0].completionAudit, true, 'existing profiles default to auditing');
    const { apiKey: _, id: __, ...profile } = service.models.get()!;
    service.models.save({ ...profile, completionAudit: false }, id);
    const session = await service.createSession('a', 'no-audit', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '把高度改成 768');
    const done = await drain(service, task.id);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.ok(service.snapshot(session.id, 'a', 0).events.some(e => e.kind === 'assistant' && e.data.text === '已改好。'));
  } finally { await service.stop(); }
});

test('transient provider failures re-queue the step with backoff and do not consume the model-call budget', async () => {
  const adapter = new FakeComfy();
  let attempts = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => { if (++attempts <= 2) throw rateLimited(); return answer('好的。'); } });
  const service = new AgentService(withProfile({ agentRetries: 3 }), { model, adapter });
  try {
    const { apiKey: _, id, ...profile } = service.models.get()!;
    service.models.save({ ...profile, completionAudit: false }, id);
    const session = await service.createSession('a', 'retry', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '你好');
    const done = await drain(service, task.id);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(attempts, 3, 'two rejected calls, then the answer');
    assert.equal(done.steps, 1, 'rejected calls are given back');
    const retries = service.snapshot(session.id, 'a', 0).events.filter(e => e.kind === 'retry');
    assert.deepEqual(retries.map(e => e.data.attempt), [1, 2]);
    assert.ok(retries.every(e => e.data.reason === 'AI_APICallError'));
  } finally { await service.stop(); }
  const exhausted = new AgentService(withProfile({ agentRetries: 1 }), { model: new MockLanguageModelV3({ doGenerate: async () => { throw rateLimited(); } }), adapter });
  try {
    const session = await exhausted.createSession('a', 'retry', textToImage(info, checkpoint, 'test'));
    const task = exhausted.enqueue(session.id, 'a', randomUUID(), '你好');
    const done = await drain(exhausted, task.id);
    assert.equal(done.state, 'failed');
    assert.match(done.error!, /暂时不可用/);
    assert.equal(exhausted.snapshot(session.id, 'a', 0).events.filter(e => e.kind === 'retry').length, 1);
  } finally { await exhausted.stop(); }
  const auth = new AgentService(withProfile({ agentRetries: 3 }), { model: new MockLanguageModelV3({ doGenerate: async () => { throw new APICallError({ message: 'unauthorized', url: 'http://unused.invalid', requestBodyValues: {}, statusCode: 401 }); } }), adapter });
  try {
    const session = await auth.createSession('a', 'auth', textToImage(info, checkpoint, 'test'));
    const task = auth.enqueue(session.id, 'a', randomUUID(), '你好');
    const done = await drain(auth, task.id);
    assert.equal(done.state, 'failed');
    assert.equal(auth.snapshot(session.id, 'a', 0).events.filter(e => e.kind === 'retry').length, 0, 'auth errors never retry');
  } finally { await auth.stop(); }
});

test('sessions run model calls concurrently up to the configured limit while each session stays serial', async () => {
  for (const concurrency of [1, 2]) {
    const adapter = new FakeComfy();
    let inFlight = 0, peak = 0;
    const model = new MockLanguageModelV3({ doGenerate: async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 20));
      inFlight--;
      return answer('好的。');
    } });
    const service = new AgentService({ ...withProfile(), agentConcurrency: concurrency }, { model, adapter });
    try {
      const { apiKey: _, id, ...profile } = service.models.get()!;
      service.models.save({ ...profile, completionAudit: false }, id);
      const first = await service.createSession('a', 'one', textToImage(info, checkpoint, 'test'));
      const second = await service.createSession('a', 'two', textToImage(info, checkpoint, 'test'));
      const tasks = [service.enqueue(first.id, 'a', randomUUID(), '一'), service.enqueue(second.id, 'a', randomUUID(), '二')];
      assert.throws(() => service.enqueue(first.id, 'a', randomUUID(), '再来'), /当前任务/, 'a session never has two active tasks');
      await service.tick();
      assert.equal(peak, concurrency, `concurrency ${concurrency}`);
      for (const task of tasks) assert.equal((await drain(service, task.id)).state, 'completed');
      assert.equal(service.status().concurrency, concurrency);
    } finally { await service.stop(); }
  }
});

test('a confirm-policy session holds submit_preview for the user and the scheduler settles the decision', async () => {
  const adapter = new FakeComfy();
  const model = scripted([call('submit_preview', { version: 1 }), answer('预览完成。')]);
  const service = new AgentService(config(), { model, adapter });
  try {
    const session = await service.createSession('a', 'confirm', textToImage(info, checkpoint, 'test'));
    assert.equal(service.updateSession(session.id, 'a', { previewPolicy: 'confirm' }).previewPolicy, 'confirm');
    const task = service.enqueue(session.id, 'a', randomUUID(), '试跑一次');
    await service.tick();
    const held = service.store.task(task.id);
    assert.equal(held.state, 'waiting_user');
    assert.equal(adapter.submits, 0, 'nothing reaches ComfyUI before the user answers');
    assert.equal(held.approval?.version, 1);
    assert.ok(held.pausedAt);
    const events = service.snapshot(session.id, 'a', 0).events;
    assert.ok(events.some(e => e.kind === 'approval' && e.data.status === 'pending' && e.data.callId === held.approval!.callId));
    assert.equal(events.find(e => e.kind === 'tool_finished')!.data.result.status, 'awaiting_user');
    assert.ok(!events.some(e => e.kind === 'assistant'), 'the model is not asked again while the user decides');
    assert.match(JSON.stringify(model.doGenerateCalls[0].prompt), /user confirms each submit_preview/);
    assert.throws(() => service.enqueue(session.id, 'a', randomUUID(), '另一个'), /当前任务/);
    assert.throws(() => service.approve(session.id, 'a', task.id, 'wrong-call', true), /没有等待确认/);
    // Waiting for the user must not burn the task deadline.
    await service.tick();
    assert.equal(service.store.task(task.id).state, 'waiting_user');
    await new Promise(resolve => setTimeout(resolve, 5));
    const before = service.store.task(task.id).deadline;
    assert.equal(service.approve(session.id, 'a', task.id, held.approval!.callId, true).state, 'queued');
    assert.ok(service.store.task(task.id).deadline > before, 'the paused time is credited back');
    assert.throws(() => service.approve(session.id, 'a', task.id, held.approval!.callId, true), /没有等待确认/, 'a decision is final');
    await service.tick();
    assert.equal(adapter.submits, 1);
    assert.equal(service.store.task(task.id).state, 'waiting_comfy');
    const done = await drain(service, task.id);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(adapter.submits, 1);
    const all = service.snapshot(session.id, 'a', 0).events;
    assert.deepEqual(all.filter(e => e.kind === 'approval').map(e => e.data.status), ['pending', 'approved', 'submitted']);
    assert.ok(all.some(e => e.kind === 'result'));
    assert.ok(JSON.stringify(model.doGenerateCalls.at(-1)!.prompt).includes('The user approved the preview'));
  } finally { await service.stop(); }

  const declined = new AgentService(config(), { model: scripted([call('submit_preview', { version: 1 }), answer('好的，不运行了。')]), adapter: new FakeComfy() });
  try {
    const session = await declined.createSession('a', 'decline', textToImage(info, checkpoint, 'test'));
    declined.updateSession(session.id, 'a', { previewPolicy: 'confirm' });
    const task = declined.enqueue(session.id, 'a', randomUUID(), '试跑一次');
    await declined.tick();
    const held = declined.store.task(task.id);
    declined.approve(session.id, 'a', task.id, held.approval!.callId, false);
    const done = await drain(declined, task.id);
    assert.equal(done.state, 'completed', done.error);
    assert.equal(declined.adapter instanceof FakeComfy && (declined.adapter as FakeComfy).submits, 0);
    assert.ok(JSON.stringify(done.messages).includes('The user declined'));
    assert.deepEqual(declined.snapshot(session.id, 'a', 0).events.filter(e => e.kind === 'approval').map(e => e.data.status), ['pending', 'declined']);
    // Back to automatic previews: the next task submits without asking.
    assert.equal(declined.updateSession(session.id, 'a', { previewPolicy: 'auto' }).previewPolicy, undefined);
  } finally { await declined.stop(); }
});

test('token estimates are calibrated from the provider usage and persisted per model profile', async () => {
  const adapter = new FakeComfy();
  const big = { inputTokens: { total: 6000, noCache: 6000, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
  const model = new MockLanguageModelV3({ doGenerate: [{ ...answer('好的。'), usage: big }] });
  const service = new AgentService(withProfile(), { model, adapter });
  try {
    const id = service.models.get()!.id;
    const { apiKey: _, id: __, ...profile } = service.models.get()!;
    service.models.save({ ...profile, completionAudit: false }, id);
    const session = await service.createSession('a', 'calibrate', textToImage(info, checkpoint, 'test'));
    const task = service.enqueue(session.id, 'a', randomUUID(), '你好');
    assert.equal((await drain(service, task.id)).state, 'completed');
    const ratios = service.store.setting<Record<string, number>>('tokenRatios')!;
    assert.ok(ratios[id] > 1 && ratios[id] <= 2.5, `ratio moved toward the provider count: ${ratios[id]}`);
    const usage = service.snapshot(session.id, 'a', 0).events.find(e => e.kind === 'usage')!;
    assert.equal(usage.data.tokenScale, 1, 'the first call ran on the raw estimate');
  } finally { await service.stop(); }
});
