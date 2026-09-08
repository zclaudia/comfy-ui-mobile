import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_NAME_PLACEHOLDERS, chooseDefaultTab, resolveSavedTarget, serverIdOf, sessionTitle } from '../../src/components/agent/binding';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: { nodes: [], links: [] } as any, nodeCount: 0, createdAt: new Date(0), isValid: true, ...extra });

test('resolveSavedTarget prefers id and falls back to the cloud filename', () => {
  const list = [wf('a'), wf('cloud_1', { cloud: { provider: 'comfyui', filename: '海报.json' } })];
  const save = (workflowId: string, filename: string) => ({ serverId: 's', workflowId, filename, name: 'x', draftVersion: 1, graphHash: 'h', etag: 'e', opId: 'op', at: 0 });
  assert.equal(resolveSavedTarget(save('a', 'a.json'), list)?.id, 'a');
  assert.equal(resolveSavedTarget(save('gone', '海报.json'), list)?.id, 'cloud_1');
  assert.equal(resolveSavedTarget(save('gone', 'nope.json'), list), undefined);
  assert.equal(resolveSavedTarget(undefined, list), undefined);
});

test('serverIdOf normalises the ComfyUI origin', () => {
  assert.equal(serverIdOf('http://192.168.2.150:8188/'), 'http://192.168.2.150:8188');
  assert.equal(serverIdOf(' HTTP://Comfy.Local:8188 '), 'http://comfy.local:8188');
});

test('chooseDefaultTab remembers the last tab, otherwise follows agent availability', () => {
  assert.equal(chooseDefaultTab('/outputs', true), '/outputs');
  assert.equal(chooseDefaultTab('/bogus', true), '/chats');
  assert.equal(chooseDefaultTab(null, true), '/chats');
  assert.equal(chooseDefaultTab(null, false), '/workflows');
  assert.equal(chooseDefaultTab('/chats', false), '/workflows');
});

test('sessionTitle uses a chosen session name, then the first message, then the fallback; never the source name', () => {
  assert.equal(sessionTitle({ sourceRef: { serverId: 's', workflowId: 'a', filename: 'a.json', name: '海报' }, name: '别的', preview: '随便' }, '新对话'), '别的');
  assert.equal(sessionTitle({ sourceRef: { serverId: 's', workflowId: 'a', filename: 'a.json', name: '海报' }, preview: '随便' }, '新对话'), '随便');
  assert.equal(sessionTitle({ name: '海报改名' }, '新对话'), '海报改名');
  assert.equal(sessionTitle({ name: '海报改名', preview: '随便' }, '新对话'), '海报改名');
  assert.equal(sessionTitle({ preview: '现在能用哪些模型？' }, '新对话'), '现在能用哪些模型？');
  assert.equal(sessionTitle({}, '新对话'), '新对话');
});

test('sessionTitle treats the localised new-session names as unnamed', () => {
  for (const placeholder of SESSION_NAME_PLACEHOLDERS) {
    assert.equal(sessionTitle({ name: placeholder, preview: 'x' }, '新对话'), 'x', placeholder);
    assert.equal(sessionTitle({ name: placeholder }, '新对话'), '新对话', placeholder);
  }
  assert.equal(sessionTitle({ name: 'New workflow', preview: 'x' }, '新对话'), 'x');
  assert.equal(sessionTitle({ name: '新对话', preview: 'x' }, '新对话'), 'x', 'the new-chat placeholder is not a chosen name either');
});
