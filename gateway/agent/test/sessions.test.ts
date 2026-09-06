import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../store.js';
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
  assert.deepEqual(second.thumbnail, { filename: 'a.png', subfolder: 'Agent', type: 'output' }, 'a later result event with no media does not wipe the thumbnail');
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
