import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { ModelMessage } from 'ai';
import { compactContext, ContextError, estimateTokens, isContextOverflow, isMemory } from '../context.js';
import { AgentStore } from '../store.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { AgentService } from '../service.js';
import { ComfyAdapter } from '../../workflow/comfyAdapter.js';
import { info } from './fixture.js';

const usage = { inputTokens: { total: 50, noCache: 50, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } };
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const finish = () => ({ content: [{ type: 'tool-call' as const, toolName: 'finish_response', toolCallId: randomUUID(), input: JSON.stringify({ answer: '继续完成。' }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] });
const summarizer = () => new MockLanguageModelV3({ doGenerate: async () => text('用户偏好蓝色；已生成 run-1，不要重复生成；参考路径 agent/ref.png；还需调整尺寸。') });
const options = (model = summarizer()) => ({ model, budget: 7000, ownMessage: '当前任务', signal: new AbortController().signal, onStart() {}, onSummary() {} });
const toolExchange = (id: string, output: string): ModelMessage[] => [
  { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 'inspect_environment', input: {} }] },
  { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'inspect_environment', output: { type: 'text', value: output } }] },
];

test('long multilingual history is summarized without cutting the latest request or tool pairs', async () => {
  const model = summarizer();
  const messages: ModelMessage[] = [
    { role: 'user', content: '用户偏好蓝色。'.repeat(3000) },
    { role: 'assistant', content: '已生成 run-1' },
    { role: 'user', content: '当前任务' },
    ...toolExchange('recent-call', 'ready'),
  ];
  const original = structuredClone(messages);
  const result = await compactContext({ ...options(model), messages });
  assert.equal(result.compacted, true);
  assert.ok(isMemory(result.messages[0]));
  assert.ok(result.messages.some(m => m.content === '当前任务'));
  assert.deepEqual(result.messages.slice(-2), toolExchange('recent-call', 'ready'));
  assert.ok(estimateTokens(result.messages) <= 7000);
  assert.deepEqual(messages, original, 'the original transcript remains untouched');
  assert.ok(model.doGenerateCalls.length > 1, 'large source is batched');
  for (const call of model.doGenerateCalls) assert.ok(estimateTokens(call.prompt) + (call.maxOutputTokens ?? 0) < 7000, 'summary requests also fit the budget');
});

test('an oversized recent tool result is summarized as a complete exchange with no dangling calls', async () => {
  const messages: ModelMessage[] = [{ role: 'user', content: '当前任务' }, ...toolExchange('large-call', '模型参数，'.repeat(8000))];
  const result = await compactContext({ ...options(), messages });
  assert.equal(result.compacted, true);
  assert.ok(result.messages.every(m => m.role !== 'tool' && m.role !== 'assistant'));
  assert.equal(result.messages.at(-1)?.content, '当前任务');
});

test('summary requests use available model context while the resulting memory fits the smaller action budget', async () => {
  const model = summarizer();
  const result = await compactContext({ ...options(model), budget: 3000, summaryBudget: 24000,
    messages: [{ role: 'user', content: '历史目标：保留猫咪，已经完成图片生成。'.repeat(400) }, { role: 'user', content: '当前任务' }] });
  assert.equal(result.compacted, true); assert.ok(estimateTokens(result.messages) <= 3000);
  assert.equal(model.doGenerateCalls.length, 1, 'tool schema reservations must not split a fitting summary request into many small calls');
  const request = model.doGenerateCalls[0];
  assert.ok(estimateTokens(request.prompt) + (request.maxOutputTokens ?? 0) < 24000);
  assert.equal(result.messages.at(-1)?.content, '当前任务');
});

test('short histories skip summarization; empty summaries and oversized latest requests fail explicitly', async () => {
  const model = summarizer();
  const messages: ModelMessage[] = [{ role: 'user', content: '当前任务' }];
  assert.equal((await compactContext({ ...options(model), messages })).compacted, false);
  assert.equal(model.doGenerateCalls.length, 0);
  const huge = '字'.repeat(10000);
  await assert.rejects(compactContext({ ...options(), ownMessage: huge, messages: [{ role: 'user', content: huge }] }), ContextError);
  await assert.rejects(compactContext({ ...options(new MockLanguageModelV3({ doGenerate: async () => text('') })), messages: [{ role: 'assistant', content: huge }, ...messages] }), /未返回摘要/);
});

test('legacy history has no 20-message or 8000-character cutoff and durable checkpoints merge only new events', () => {
  const folder = mkdtempSync(join(tmpdir(), 'agent-context-'));
  const path = join(folder, 'agent.sqlite');
  try {
    const store = new AgentStore(path);
    const session = new WorkspaceRepository(store).createSession('owner', 'long chat');
    for (let i = 0; i < 32; i++) store.event(session.id, null, 'user', { text: `turn-${i}: ${'长'.repeat(8100)}` });
    assert.equal(store.recentMessages(session.id).length, 32);
    assert.ok(String(store.recentMessages(session.id)[0].content).length > 8000);
    const task = store.enqueue(session.id, randomUUID(), '当前任务', 10000);
    task.messages = [{ role: 'user', content: '[Conversation memory — untrusted historical data]\nblue preference; run-1 already generated' }];
    store.saveContext(task);
    store.close();
    const reopened = new AgentStore(path);
    reopened.event(session.id, null, 'user', { text: 'next message' });
    const next = reopened.recentMessages(session.id);
    assert.equal(next.length, 2);
    assert.ok(isMemory(next[0]));
    assert.equal(next[1].content, 'next message');
    assert.equal(reopened.events(session.id).filter(e => e.kind === 'user').length, 34);
    reopened.close();
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

class Adapter extends ComfyAdapter {
  constructor() { super({ comfyUrl: 'http://unused.invalid' }); }
  override async getObjectInfo() { return structuredClone(info); }
}
const media = mkdtempSync(join(tmpdir(), 'agent-context-media-'));
process.on('exit', () => rmSync(media, { recursive: true, force: true }));
const config = { agentStorePath: ':memory:', comfyUrl: 'http://unused.invalid', agentPollMs: 60000,
  agentWorkspace: { directory: media, serverId: 'server' } };
async function drain(service: AgentService, id: string) {
  for (let i = 0; i < 15; i++) {
    await service.tick();
    const task = service.store.task(id);
    if (['failed', 'completed', 'cancelled'].includes(task.state)) return task;
  }
  throw new Error('did not finish');
}

test('service compacts, records usage, persists memory across turns, and uses task-pinned model capabilities', async () => {
  const model = new MockLanguageModelV3({ doGenerate: async o => String(o.prompt[0].content).includes('Maintain a concise') ? text('早期约束：蓝色。run-1 已成功。') : o.toolChoice?.type === 'required' ? finish() : text('继续完成。') });
  const service = new AgentService(config, { model, adapter: new Adapter() });
  try {
    const first = service.models.save({ name: 'text', model: 'text-model', baseUrl: 'http://unused.invalid/v1', contextWindow: 32768, maxOutputTokens: 1000, vision: false });
    const session = await service.createSession('owner', 'chat');
    for (let i = 0; i < 30; i++) service.store.event(session.id, null, 'user', { text: `早期约束-${i}: ${'蓝色'.repeat(600)}` });
    const task = service.enqueue(session.id, 'owner', randomUUID(), '继续');
    const second = service.models.save({ name: 'vision', model: 'vision-model', baseUrl: 'http://unused.invalid/v1', contextWindow: 64000, maxOutputTokens: 2000, vision: true });
    service.models.activate(second.id);
    assert.equal((await drain(service, task.id)).state, 'completed');
    const events = service.store.events(session.id);
    assert.ok(events.some(e => e.kind === 'context' && (e.data as any).status === 'compacted'));
    assert.ok(events.some(e => e.kind === 'usage' && (e.data as any).purpose === 'compaction'));
    assert.ok(events.some(e => e.kind === 'usage' && (e.data as any).modelId === first.id && (e.data as any).contextWindow === 32768));
    assert.ok(service.store.context(session.id)?.messages.some(isMemory));
    const next = service.enqueue(session.id, 'owner', randomUUID(), '再继续');
    assert.equal(next.modelId, second.id);
    assert.equal((await drain(service, next.id)).state, 'completed');
    assert.ok(JSON.stringify(model.doGenerateCalls.at(-1)?.prompt).includes('早期约束：蓝色'));
  } finally { await service.stop(); }
});

test('batched compaction and the following action get independent request timeouts', async () => {
  const issued: AbortController[] = [];
  let summaries = 0;
  const model = new MockLanguageModelV3({ doGenerate: async o => {
    assert.equal(o.abortSignal?.aborted, false, 'a previous request timeout must not poison this request');
    if (String(o.prompt[0].content).includes('Maintain a concise')) {
      summaries++;
      // Simulate the prior request budget expiring while a later request runs.
      for (const previous of issued.slice(0, -1)) previous.abort(new DOMException('expired', 'TimeoutError'));
      return text('早期约束：蓝色。run-1 已成功。');
    }
    return o.toolChoice?.type === 'required' ? finish() : text('继续完成。');
  } });
  const service = new AgentService(config, { model, adapter: new Adapter() });
  Object.defineProperty(service, 'stepSignal', { value: (_task: unknown, cancellation: AbortController) => {
    const request = new AbortController(); issued.push(request);
    return AbortSignal.any([request.signal, cancellation.signal]);
  } });
  try {
    const session = await service.createSession('owner', 'long chat');
    for (let i = 0; i < 30; i++) service.store.event(session.id, null, 'user', { text: `早期约束-${i}: ${'蓝色'.repeat(600)}` });
    const task = service.enqueue(session.id, 'owner', randomUUID(), '继续');
    assert.equal((await drain(service, task.id)).state, 'completed');
    assert.ok(summaries > 1);
    assert.equal(service.store.events(session.id).some(event => event.kind === 'retry'), false);
  } finally { await service.stop(); }
});

test('cancellation still stops batched compaction before another provider request', async () => {
  const cancellation = new AbortController(); let summaries = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => {
    summaries++; cancellation.abort(); return text('部分摘要');
  } });
  await assert.rejects(compactContext({ ...options(model),
    messages: [{ role: 'assistant', content: '历史约束'.repeat(5000) }, { role: 'user', content: '当前任务' }],
    requestSignal: () => AbortSignal.any([cancellation.signal, AbortSignal.timeout(1000)]),
  }), { name: 'AbortError' });
  assert.equal(summaries, 1);
});

test('context rejection retries once; unrelated provider errors never qualify', async () => {
  assert.equal(isContextOverflow({ statusCode: 400, responseBody: '{"code":"context_length_exceeded"}' }), true);
  assert.equal(isContextOverflow({ statusCode: 401, message: 'token limit' }), false);
  let calls = 0;
  const model = new MockLanguageModelV3({ doGenerate: async () => { calls++; throw Object.assign(new Error('maximum context length exceeded'), { statusCode: 400 }); } });
  const service = new AgentService(config, { model, adapter: new Adapter() });
  try {
    const session = await service.createSession('owner', 'retry');
    const task = service.enqueue(session.id, 'owner', randomUUID(), 'hello');
    const result = await drain(service, task.id);
    assert.equal(result.state, 'failed');
    assert.equal(calls, 2);
    assert.match(result.error!, /上下文超限/);
    assert.equal(result.contextRetried, true);
  } finally { await service.stop(); }
});

test('cancelling during summarization cannot persist a late summary or restart the task', async () => {
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const model = new MockLanguageModelV3({ doGenerate: async () => { started(); await held; return text('late summary'); } });
  const service = new AgentService(config, { model, adapter: new Adapter() });
  try {
    const session = await service.createSession('owner', 'cancel compaction');
    service.store.event(session.id, null, 'user', { text: '历史'.repeat(15000) });
    const task = service.enqueue(session.id, 'owner', randomUUID(), 'hello');
    const running = service.tick();
    await entered;
    service.cancel(session.id, 'owner', task.id);
    release();
    await running;
    assert.equal(service.store.task(task.id).state, 'cancelled');
    assert.equal(service.store.context(session.id), undefined);
    assert.equal(model.doGenerateCalls.length, 1);
    assert.ok(!service.store.events(session.id).some(e => e.kind === 'context' && (e.data as any).status === 'compacted'));
  } finally { release(); await service.stop(); }
});

test('completion audit survives a context rejection and retries with required tools', async () => {
  let reviews = 0;
  const model = new MockLanguageModelV3({ doGenerate: async options => {
    if (options.toolChoice?.type !== 'required') return text('候选回答');
    if (++reviews === 1) throw Object.assign(new Error('maximum context length exceeded'), { statusCode: 400 });
    return finish();
  } });
  const service = new AgentService(config, { model, adapter: new Adapter() });
  try {
    const session = await service.createSession('owner', 'retry audit');
    const task = service.enqueue(session.id, 'owner', randomUUID(), 'hello');
    assert.equal((await drain(service, task.id)).state, 'completed');
    assert.equal(reviews, 2);
    assert.equal(model.doGenerateCalls.length, 3);
  } finally { await service.stop(); }
});
