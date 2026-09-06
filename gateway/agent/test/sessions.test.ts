import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentStore } from '../store.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const canvas = () => textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'test');

test('store keeps the workflow binding, summarises sessions and cascades deletion', () => {
  const store = new AgentStore(':memory:');
  const bound = store.create('me', '海报', canvas(), { id: 'wf-1', name: '海报', filename: '海报.json' });
  assert.deepEqual(bound.workflow, { id: 'wf-1', name: '海报', filename: '海报.json' });
  const blank = store.create('me', '新工作流');
  store.create('other', '别人的');
  store.enqueue(blank.id, 'r-1', '现在能用哪些模型？', 60_000);
  store.event(bound.id, null, 'result', { version: 1, outputs: [{ filename: 'a.png', subfolder: 'Agent', type: 'output', kind: 'image' }] });

  const list = store.list('me');
  assert.deepEqual(list.map(s => s.id), [bound.id, blank.id], 'latest activity first');
  const [first, second] = list;
  assert.equal(first.active, false);
  assert.deepEqual(first.thumbnail, { filename: 'a.png', subfolder: 'Agent', type: 'output' });
  assert.equal(first.lastMessage, undefined);
  assert.equal(second.active, true);
  assert.equal(second.lastState, 'queued');
  assert.equal(second.preview, '现在能用哪些模型？');
  assert.equal(second.lastMessage, '现在能用哪些模型？');
  assert.ok(second.lastActivity >= second.created);

  const renamed = store.updateSession(blank.id, { workflow: { id: 'wf-2', name: '模型清单' } });
  assert.equal(renamed.name, '模型清单');
  assert.deepEqual(renamed.workflow, { id: 'wf-2', name: '模型清单' });
  const unbound = store.updateSession(blank.id, { workflow: null });
  assert.equal(unbound.workflow, undefined);
  assert.equal(unbound.name, '模型清单');
  assert.equal(store.updateSession(blank.id, { name: '改名' }).name, '改名');

  store.deleteSession(bound.id);
  assert.throws(() => store.session(bound.id), /会话不存在/);
  assert.equal(store.events(bound.id).length, 0);
  assert.equal(store.versions(bound.id).length, 0);
  assert.deepEqual(store.list('me').map(s => s.id), [blank.id]);
  store.close();
});
