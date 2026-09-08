import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentStore, describeAttachments } from '../store.js';
import { AgentService } from '../service.js';
import { WorkflowError } from '../../workflow/engine.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const canvas = () => textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'test');
// events/sessions are ordered by real timestamps with a stable tie-break, so tests that assert
// relative ordering must force distinct milliseconds between the steps being compared.
const tick = () => new Promise(resolve => setTimeout(resolve, 2));

test('list summaries', async () => {
  const store = new AgentStore(':memory:');
  const bound = store.create('me', '海报', canvas(), { id: 'wf-1', name: '海报', filename: '海报.json' });
  assert.deepEqual(bound.workflow, { id: 'wf-1', name: '海报', filename: '海报.json' });
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
  assert.deepEqual(second.thumbnail, { filename: 'a.png', subfolder: 'Agent', type: 'output', kind: 'image' }, 'a later result event with no media does not wipe the thumbnail');
  assert.equal(second.lastMessage, undefined);
  assert.equal(third.active, true);
  assert.equal(third.lastState, 'queued');
  assert.equal(third.preview, '现在能用哪些模型？');
  assert.equal(third.lastMessage, '现在能用哪些模型？');
  assert.ok(third.lastActivity >= third.created);

  store.close();
});

test('updateSession', () => {
  const store = new AgentStore(':memory:');
  const blank = store.create('me', '新工作流');

  const renamed = store.updateSession(blank.id, { workflow: { id: 'wf-2', name: '模型清单' } });
  assert.equal(renamed.name, '模型清单');
  assert.deepEqual(renamed.workflow, { id: 'wf-2', name: '模型清单' });
  const unbound = store.updateSession(blank.id, { workflow: null });
  assert.equal(unbound.workflow, undefined);
  assert.equal(unbound.name, '模型清单');
  assert.equal(store.updateSession(blank.id, { name: '改名' }).name, '改名');

  const explicit = store.updateSession(blank.id, { name: 'explicit', workflow: { id: 'wf-3', name: 'from-wf' } });
  assert.equal(explicit.name, 'explicit', 'explicit name wins over the workflow name');
  assert.deepEqual(explicit.workflow, { id: 'wf-3', name: 'from-wf' });

  store.close();
});

const service = () => new AgentService({ agentStorePath: ':memory:', comfyUrl: 'http://unused.invalid', agentPollMs: 60_000 }, { model: new MockLanguageModelV3({ doGenerate: async () => { throw new Error('model must not be called'); } }) });

test('service imports canvas versions, rejects unsupported canvases and cancels tasks on delete', async () => {
  const agent = service();
  const session = await agent.createSession('me', '忽略', canvas(), { id: 'wf-1', name: '海报' });
  assert.equal(session.name, '海报', 'binding name wins over request name');
  const imported = agent.importVersion(session.id, 'me', canvas(), 1, '画布修改');
  assert.equal(imported.version, 2);
  const events = agent.store.events(session.id);
  assert.deepEqual(events.at(-1)?.data, { version: 2, summary: '画布修改', source: 'canvas' });
  assert.throws(() => agent.importVersion(session.id, 'me', canvas(), 1, '过期'), /版本已改变/);
  const broken = canvas(); (broken.nodes[0] as { mode?: number }).mode = 4;
  assert.throws(() => agent.importVersion(session.id, 'me', broken, 2, '坏画布'), WorkflowError);
  assert.throws(() => agent.importVersion(session.id, 'someone-else', canvas(), 2, '越权'), /会话不存在/);

  assert.deepEqual(agent.updateSession(session.id, 'me', { workflow: null }).workflow, undefined);
  assert.throws(() => agent.updateSession(session.id, 'someone-else', { name: 'x' }), /会话不存在/);
  assert.throws(() => agent.deleteSession(session.id, 'someone-else'), /会话不存在/);

  const task = agent.enqueue(session.id, 'me', randomUUID(), '开始一个任务');
  assert.throws(() => agent.importVersion(session.id, 'me', canvas(), 2, '任务中'), /先停止当前任务/);
  assert.deepEqual(agent.deleteSession(session.id, 'me'), { deleted: true });
  assert.throws(() => agent.store.task(task.id), /任务不存在/);
  assert.throws(() => agent.store.session(session.id), /会话不存在/);
  await agent.stop();
});

test('deleteSession', () => {
  const store = new AgentStore(':memory:');
  const bound = store.create('me', '海报', canvas(), { id: 'wf-1', name: '海报', filename: '海报.json' });
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
  const attachments = [{ filename: 'ref.png', subfolder: 'agent', type: 'input', kind: 'image' as const, name: 'IMG_0001.png', size: 1234, width: 768, height: 1024 }];
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
  assert.match(message.content, /768x1024px portrait/, 'dimensions and orientation are spelled out for the model');
  assert.equal(describeAttachments('x', [{ filename: 'a.png', subfolder: '', type: 'input', kind: 'image' }]).includes('px'), false, 'no dimensions, no claim');
  assert.match(describeAttachments('x', [{ filename: 'a.png', subfolder: '', type: 'input', kind: 'image', width: 512, height: 512 }]), /512x512px square/);
  assert.equal(store.list('me')[0].preview, '按这张图的风格再画一张');
  assert.equal(store.enqueue(store.create('me', '无附件').id, 'r-2', '纯文字', 60_000).attachments, undefined, 'text-only tasks carry no attachment key');
});

test('session thumbnails follow the latest result and prefer a still frame over video and audio within it', async () => {
  const store = new AgentStore(':memory:');
  const session = store.create('me', '视频');
  store.event(session.id, null, 'result', { version: 1, outputs: [{ filename: 'old.png', subfolder: '', type: 'output', kind: 'image' }] });
  await tick();
  store.event(session.id, null, 'result', { version: 2, outputs: [{ filename: 'clip.mp4', subfolder: 'video', type: 'output', kind: 'video' }, { filename: 'clip.wav', subfolder: 'video', type: 'output', kind: 'audio' }] });
  assert.deepEqual(store.list('me')[0].thumbnail, { filename: 'clip.mp4', subfolder: 'video', type: 'output', kind: 'video' }, 'a video-only result shows its video, not an older image');
  await tick();
  store.event(session.id, null, 'result', { version: 3, outputs: [{ filename: 'audio.wav', subfolder: '', type: 'output', kind: 'audio' }, { filename: 'take2.mp4', subfolder: '', type: 'output', kind: 'video' }, { filename: 'frame.png', subfolder: '', type: 'output', kind: 'image' }] });
  assert.deepEqual(store.list('me')[0].thumbnail, { filename: 'frame.png', subfolder: '', type: 'output', kind: 'image' }, 'a still frame in the same result wins regardless of order');
  store.event(session.id, null, 'result', { version: 4, outputs: [{ filename: 'legacy.mp4', subfolder: '', type: 'output' }] });
  assert.deepEqual(store.list('me')[0].thumbnail, { filename: 'legacy.mp4', subfolder: '', type: 'output' }, 'outputs recorded without kind still surface; the App derives the kind');
  store.close();
});
