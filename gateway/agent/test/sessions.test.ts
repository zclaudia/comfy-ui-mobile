import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentStore } from '../store.js';
import { AgentService } from '../service.js';
import { WorkflowError } from '../../workflow/engine.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const canvas = () => textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'test');
// events/sessions are ordered by real timestamps with a stable tie-break, so tests that assert
// relative ordering must force distinct milliseconds between the steps being compared.
const tick = () => new Promise(resolve => setTimeout(resolve, 2));

const source = { serverId: 'http://comfy.local:8188', workflowId: 'wf-1', filename: '海报.json', name: '海报', etag: 'e1' };

test('list summaries', async () => {
  const store = new AgentStore(':memory:');
  const bound = store.create('me', '海报', canvas(), source);
  assert.deepEqual(bound.sourceRef, source);
  assert.equal(bound.workspaceMode, 'draft');
  const blank = store.create('me', '新工作流');
  store.create('other', '别人的');
  store.enqueue(blank.id, 'r-1', '现在能用哪些模型？', 60_000);
  await tick();
  store.event(bound.id, null, 'result', { version: 1, outputs: [{ filename: 'a.png', subfolder: 'Agent', type: 'output', kind: 'image' }] });
  store.event(bound.id, null, 'result', { version: 2, outputs: [] });
  await tick();
  const empty = store.create('me', '空会话');

  const list = store.list('me');
  assert.deepEqual(list.map(s => s.id), [empty.id, bound.id, blank.id], 'latest activity first, event-less session newest');
  const [first, second, third] = list;
  assert.equal(first.active, false);
  assert.equal(second.active, false);
  assert.deepEqual(second.thumbnail, { filename: 'a.png', subfolder: 'Agent', type: 'output' }, 'a later result event with no media does not wipe the thumbnail');
  assert.equal(second.lastMessage, undefined);
  assert.equal(third.active, true);
  assert.equal(third.lastState, 'queued');
  assert.equal(third.preview, '现在能用哪些模型？');
  assert.equal(third.lastMessage, '现在能用哪些模型？');
  assert.ok(third.lastActivity >= third.created);

  store.close();
});

test('updateSession keeps the session name independent of its source', () => {
  const store = new AgentStore(':memory:');
  const blank = store.create('me', '新工作流');

  const sourced = store.updateSession(blank.id, { sourceRef: source });
  assert.equal(sourced.name, '新工作流', 'attaching a source does not rename the session');
  assert.deepEqual(sourced.sourceRef, source);
  const detached = store.updateSession(blank.id, { sourceRef: null });
  assert.equal(detached.sourceRef, undefined);
  assert.equal(store.updateSession(blank.id, { name: '改名' }).name, '改名');

  store.close();
});

const service = () => new AgentService({ agentStorePath: ':memory:', comfyUrl: 'http://unused.invalid', agentPollMs: 60_000 }, { model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error('model must not be called'); } }) });

test('service imports canvas versions, rejects unsupported canvases and cancels tasks on delete', async () => {
  const agent = service();
  const session = await agent.createSession('me', '我的会话', canvas(), source);
  assert.equal(session.name, '我的会话', 'the source name never overrides the session name');
  const requestId = randomUUID();
  const imported = agent.importVersion(session.id, 'me', canvas(), 1, '画布修改', requestId);
  assert.equal(imported.version, 2);
  assert.deepEqual(agent.importVersion(session.id, 'me', canvas(), 1, '画布修改', requestId), { version: 2 }, 'a retried request returns the version it already made');
  assert.equal(agent.store.session(session.id).version, 2);
  const events = agent.store.events(session.id);
  assert.deepEqual(events.at(-1)?.data, { version: 2, summary: '画布修改', source: 'canvas' });
  assert.throws(() => agent.importVersion(session.id, 'me', canvas(), 1, '过期'), /版本已改变/);
  const broken = canvas(); (broken.nodes[0] as { mode?: number }).mode = 4;
  assert.throws(() => agent.importVersion(session.id, 'me', broken, 2, '坏画布'), WorkflowError);
  assert.throws(() => agent.importVersion(session.id, 'someone-else', canvas(), 2, '越权'), /会话不存在/);

  assert.deepEqual(agent.updateSession(session.id, 'me', { sourceRef: null }).sourceRef, undefined);
  assert.equal(agent.snapshot(session.id, 'me', 0).versionsHasMore, false);
  assert.throws(() => agent.updateSession(session.id, 'someone-else', { name: 'x' }), /会话不存在/);
  assert.throws(() => agent.deleteSession(session.id, 'someone-else'), /会话不存在/);

  const task = agent.enqueue(session.id, 'me', randomUUID(), '开始一个任务');
  assert.throws(() => agent.importVersion(session.id, 'me', canvas(), 2, '任务中'), /先停止当前任务/);
  assert.deepEqual(agent.deleteSession(session.id, 'me'), { deleted: true });
  assert.throws(() => agent.store.task(task.id), /任务不存在/);
  assert.throws(() => agent.store.session(session.id), /会话不存在/);
  await agent.stop();
});

test('library save operations move forward once, reject a second concurrent operation and gate lastLibrarySave', () => {
  const store = new AgentStore(':memory:');
  const session = store.create('me', '海报', canvas());
  const hash = 'a'.repeat(64);
  const op = (state: string, extra: Record<string, unknown> = {}) => ({ opId: 'op-1', mode: 'create' as const, draftVersion: 1, graphHash: hash, target: { serverId: source.serverId, workflowId: 'wf-new', filename: '海报.json', name: '海报' }, state: state as never, startedBy: 'phone', startedAt: 1, updatedAt: 1, ...extra });

  assert.throws(() => store.updateSession(session.id, { librarySaveOp: op('applying') }), /必须从 pending 开始/);
  assert.equal(store.updateSession(session.id, { librarySaveOp: op('pending') }).librarySaveOp?.state, 'pending');
  assert.equal(store.updateSession(session.id, { librarySaveOp: op('pending') }).librarySaveOp?.state, 'pending', 'identical patch is an idempotent retry');
  assert.throws(() => store.updateSession(session.id, { librarySaveOp: { ...op('pending'), opId: 'op-2' } }), /另一设备正在保存/);
  assert.throws(() => store.updateSession(session.id, { librarySaveOp: op('succeeded') }), /不能从 pending 变为 succeeded/);
  assert.throws(() => store.updateSession(session.id, { librarySaveOp: op('applying', { draftVersion: 2 }) }), /内容与已记录的不一致/);
  assert.throws(() => store.updateSession(session.id, { lastLibrarySave: { ...source, workflowId: 'wf-new', draftVersion: 1, graphHash: hash, etag: 'e2', opId: 'op-1', at: 2 } }), /尚未成功/);
  assert.equal(store.updateSession(session.id, { librarySaveOp: op('applying', { updatedAt: 2 }) }).librarySaveOp?.state, 'applying');
  assert.equal(store.updateSession(session.id, { librarySaveOp: op('reconciling', { updatedAt: 3 }) }).librarySaveOp?.state, 'reconciling');
  assert.throws(() => store.updateSession(session.id, { librarySaveOp: op('applying', { updatedAt: 4 }) }), /不能从 reconciling 变为 applying/);
  const done = store.updateSession(session.id, { librarySaveOp: op('succeeded', { updatedAt: 5, result: { etag: 'e2' } }), lastLibrarySave: { ...source, workflowId: 'wf-new', draftVersion: 1, graphHash: hash, etag: 'e2', opId: 'op-1', at: 5 } });
  assert.equal(done.lastLibrarySave?.etag, 'e2');
  assert.throws(() => store.updateSession(session.id, { librarySaveOp: op('failed', { updatedAt: 6 }) }), /不能从 succeeded 变为 failed/);
  assert.equal(store.updateSession(session.id, { librarySaveOp: { ...op('pending'), opId: 'op-2' } }).librarySaveOp?.opId, 'op-2', 'a finished operation makes room for the next one');
  assert.throws(() => store.updateSession(session.id, { lastLibrarySave: { ...source, workflowId: 'wf-new', draftVersion: 1, graphHash: hash, etag: 'e3', opId: 'op-2', at: 7 } }), /尚未成功/);

  store.close();
});

test('markLegacySessions flags pre-draft sessions once and keeps the old binding as evidence', () => {
  const store = new AgentStore(':memory:');
  const session = store.create('me', '旧会话', canvas());
  store.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ id: session.id, owner: 'me', name: '旧会话', version: 1, created: 1, workflow: { id: 'wf-1', name: '海报' } }), session.id);
  assert.equal(store.markLegacySessions(), 1);
  const legacy = store.session(session.id);
  assert.equal(legacy.workspaceMode, 'legacy');
  assert.deepEqual(legacy.legacyWorkflow, { id: 'wf-1', name: '海报' });
  assert.equal((legacy as { workflow?: unknown }).workflow, undefined);
  assert.equal(store.markLegacySessions(), 0, 'repeatable');
  const migrated = store.updateSession(session.id, { workspaceMode: 'draft', sourceRef: source, lastLibrarySave: { ...source, draftVersion: 1, graphHash: 'b'.repeat(64), etag: '', opId: 'legacy', at: 2 } });
  assert.equal(migrated.workspaceMode, 'draft');
  assert.equal(migrated.lastLibrarySave?.opId, 'legacy');
  assert.throws(() => store.updateSession(session.id, { lastLibrarySave: { ...source, draftVersion: 1, graphHash: 'b'.repeat(64), etag: '', opId: 'legacy', at: 3 } }), /尚未成功/, 'legacy claims only ride along with the migration itself');
  store.close();
});

test('versionsPage walks back through history without silently truncating', () => {
  const store = new AgentStore(':memory:');
  const session = store.create('me', '多版本', canvas());
  for (let v = 1; v < 120; v++) store.transaction(() => store.commitVersion(session.id, v, canvas(), `v${v + 1}`));
  const first = store.versionsPage(session.id, undefined, 50);
  assert.equal(first.versions.length, 50); assert.equal(first.versions[0].version, 120); assert.equal(first.hasMore, true);
  const second = store.versionsPage(session.id, first.versions.at(-1)!.version, 50);
  assert.equal(second.versions[0].version, 70); assert.equal(second.hasMore, true);
  const last = store.versionsPage(session.id, second.versions.at(-1)!.version, 50);
  assert.equal(last.versions.length, 20); assert.equal(last.versions.at(-1)!.version, 1); assert.equal(last.hasMore, false);
  assert.equal(store.versions(session.id).length, 100, 'the legacy accessor still caps at 100');
  store.close();
});

test('deleteSession', () => {
  const store = new AgentStore(':memory:');
  const bound = store.create('me', '海报', canvas(), source);
  const blank = store.create('me', '新工作流');
  store.event(bound.id, null, 'result', { version: 1, outputs: [{ filename: 'a.png', subfolder: 'Agent', type: 'output', kind: 'image' }] });
  store.enqueue(bound.id, 'r-1', '现在能用哪些模型？', 60_000);

  store.deleteSession(bound.id);
  assert.throws(() => store.session(bound.id), /会话不存在/);
  assert.equal(store.events(bound.id).length, 0);
  assert.equal(store.versions(bound.id).length, 0);
  assert.equal(store.tasks(bound.id).length, 0);
  assert.deepEqual(store.list('me').map(s => s.id), [blank.id]);

  store.close();
});

test('attachments ride along with the user message and are described to the model', () => {
  const store = new AgentStore(':memory:');
  const session = store.create('me', '参考图');
  const attachments = [{ filename: 'ref.png', subfolder: 'agent', type: 'input', kind: 'image' as const, name: 'IMG_0001.png', size: 1234 }];
  const task = store.enqueue(session.id, 'r-1', '按这张图的风格再画一张', 60_000, attachments);
  assert.deepEqual(task.attachments, attachments);
  assert.equal(store.enqueue(session.id, 'r-1', '按这张图的风格再画一张', 60_000, attachments).id, task.id, 'same request id with same payload is idempotent');
  assert.throws(() => store.enqueue(session.id, 'r-1', '按这张图的风格再画一张', 60_000, []), /请求 ID/);
  const user = store.events(session.id).find(e => e.kind === 'user')!;
  assert.deepEqual(user.data, { text: '按这张图的风格再画一张', attachments });
  const [message] = store.recentMessages(session.id);
  assert.match(message.content, /^按这张图的风格再画一张/);
  assert.match(message.content, /image "agent\/ref\.png" \(original name: IMG_0001\.png\)/);
  assert.match(message.content, /LoadImage\.image/);
  assert.equal(store.list('me')[0].preview, '按这张图的风格再画一张');
  assert.equal(store.enqueue(store.create('me', '无附件').id, 'r-2', '纯文字', 60_000).attachments, undefined, 'text-only tasks carry no attachment key');
});
