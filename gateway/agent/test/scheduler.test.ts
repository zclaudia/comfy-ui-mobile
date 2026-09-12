/** Scheduler behaviour that is independent of any tool: prompt-cache stability, provider retries, budget and calibration. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { APICallError } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentService } from '../service.js';
import type { AgentConfig } from '../service.js';
import { WorkspaceComfy } from './workspaceFixture.js';

const usage = { inputTokens: { total: 1200, noCache: 1200, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 20, text: 20, reasoning: undefined } };
const answer = (text = '好的。') => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: 'stop' }, usage, warnings: [] });
const finish = (text = '好的。') => ({ content: [{ type: 'tool-call' as const, toolName: 'finish_response', toolCallId: randomUUID(), input: JSON.stringify({ answer: text }) }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] });
const inspect = () => ({ content: [{ type: 'tool-call' as const, toolName: 'inspect_environment', toolCallId: randomUUID(), input: '{}' }], finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' }, usage, warnings: [] });
const rateLimited = () => new APICallError({ message: 'rate limited', url: 'http://provider.invalid/v1', requestBodyValues: {}, statusCode: 429, isRetryable: true });
const scripted = (steps: ReturnType<typeof answer>[]) => { let index = 0; return new MockLanguageModelV3({ doGenerate: async () => steps[Math.min(index++, steps.length - 1)] }); };

function fixture(t: { after: (fn: () => unknown) => void }, extra: Partial<AgentConfig> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agent-scheduler-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, adapter: new WorkspaceComfy(), config: { agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentPollMs: 60_000,
    agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' }, ...extra } as AgentConfig };
}
async function drain(service: AgentService, id: string) {
  for (let i = 0; i < 15; i++) {
    await service.tick();
    const task = service.store.task(id);
    if (['failed', 'completed', 'cancelled'].includes(task.state)) return task;
  }
  throw new Error('did not finish');
}
const profileOf = (service: AgentService, patch: Record<string, unknown> = {}) => {
  const saved = service.models.save({ name: 'p', model: 'test-model', baseUrl: 'http://unused.invalid/v1', contextWindow: 32768, maxOutputTokens: 1000, vision: false, ...patch });
  service.models.activate(saved.id);
  return saved;
};

test('the system prompt and tool schemas stay byte-identical across steps; volatile state rides in a trailing message', async t => {
  const { adapter, config } = fixture(t);
  const service = new AgentService(config, { adapter, model: scripted([inspect(), inspect(), finish()]) });
  t.after(() => service.stop());
  const session = await service.createSession('owner', 'cache');
  const task = service.enqueue(session.id, 'owner', randomUUID(), '看看能做什么');
  assert.equal((await drain(service, task.id)).state, 'completed');
  const calls = (service as unknown as { model: MockLanguageModelV3 }).model.doGenerateCalls;
  assert.ok(calls.length >= 3);
  const system = (call: (typeof calls)[number]) => call.prompt.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const tools = (call: (typeof calls)[number]) => JSON.stringify(call.tools);
  for (let i = 1; i < 3; i++) {
    assert.equal(system(calls[i]), system(calls[0]), `step ${i} system prompt changed`);
    assert.equal(tools(calls[i]), tools(calls[0]), `step ${i} tool schemas changed`);
  }
  const trailing = (call: (typeof calls)[number]) => { const message = call.prompt.at(-1)!; return message.role === 'user' && message.content[0]?.type === 'text' ? message.content[0].text : ''; };
  assert.match(trailing(calls[0]), /^\[Workspace state/);
  assert.match(trailing(calls[0]), /remainingSteps/);
  assert.ok(!system(calls[0]).includes('remainingSteps'), 'volatile counters must not live in the cached prefix');
  assert.ok(!JSON.stringify(service.store.task(task.id).messages).includes('[Workspace state'), 'state is rebuilt per step, never persisted');
});

test('transient provider failures re-queue the step with backoff and are given back to the model-call budget', async t => {
  const { adapter, config } = fixture(t, { agentRetries: 3, agentRetryDelayMs: 0 });
  let attempts = 0;
  const service = new AgentService(config, { adapter, model: new MockLanguageModelV3({ doGenerate: async () => { if (++attempts <= 2) throw rateLimited(); return answer('好的。'); } }) });
  t.after(() => service.stop());
  profileOf(service, { completionAudit: false });
  const session = await service.createSession('owner', 'retry');
  const task = service.enqueue(session.id, 'owner', randomUUID(), '你好');
  const done = await drain(service, task.id);
  assert.equal(done.state, 'completed', done.error);
  assert.equal(attempts, 3, 'two rejected calls, then the answer');
  assert.equal(done.steps, 1, 'rejected calls are refunded');
  const retries = service.store.events(session.id).filter(event => event.kind === 'retry');
  assert.deepEqual(retries.map(event => event.data.attempt), [1, 2]);
  assert.ok(retries.every(event => event.data.reason === 'AI_APICallError'));
});

test('an exhausted retry budget fails the task with a provider-outage message instead of looping', async t => {
  const { adapter, config } = fixture(t, { agentRetries: 1, agentRetryDelayMs: 0 });
  const service = new AgentService(config, { adapter, model: new MockLanguageModelV3({ doGenerate: async () => { throw rateLimited(); } }) });
  t.after(() => service.stop());
  profileOf(service, { completionAudit: false });
  const session = await service.createSession('owner', 'retry');
  const task = service.enqueue(session.id, 'owner', randomUUID(), '你好');
  const done = await drain(service, task.id);
  assert.equal(done.state, 'failed');
  assert.match(done.error!, /暂时不可用/);
});

test('a profile can switch the completion audit off so a text-only answer completes in one call', async t => {
  const { adapter, config } = fixture(t);
  const model = new MockLanguageModelV3({ doGenerate: async () => answer('已改好。') });
  const service = new AgentService(config, { adapter, model });
  t.after(() => service.stop());
  profileOf(service, { completionAudit: false });
  const session = await service.createSession('owner', 'audit');
  const task = service.enqueue(session.id, 'owner', randomUUID(), '你好');
  assert.equal((await drain(service, task.id)).state, 'completed');
  assert.equal(model.doGenerateCalls.length, 1, 'no audit call follows a text-only answer');
});

test('token estimates are calibrated from real provider usage and persisted per model profile', async t => {
  const { adapter, config } = fixture(t);
  const service = new AgentService(config, { adapter, model: scripted([finish()]) });
  t.after(() => service.stop());
  const profile = profileOf(service, { completionAudit: false });
  const session = await service.createSession('owner', 'calibration');
  const task = service.enqueue(session.id, 'owner', randomUUID(), '你好'.repeat(400));
  assert.equal((await drain(service, task.id)).state, 'completed');
  const ratios = service.store.setting<Record<string, number>>('tokenRatios');
  assert.ok(ratios && typeof ratios[profile.id] === 'number', 'the profile keeps its own multiplier');
  assert.ok(ratios![profile.id] > 0 && ratios![profile.id] <= 2.5);
});
