import test from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_NAME_PLACEHOLDERS, chooseDefaultTab, relativeTime, serverIdOf, sessionTitle } from '../../src/components/agent/binding';

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

test('relativeTime steps from minutes to a date as a session ages', () => {
  const at = (text: string, values: Record<string, string | number> = {}) => text.replace('{{count}}', String(values.count ?? ''));
  const now = Date.UTC(2026, 0, 20, 12, 0, 0);
  assert.equal(relativeTime(now - 20_000, now, at), '刚刚');
  assert.equal(relativeTime(now - 45 * 60_000, now, at), '45 分钟前');
  assert.equal(relativeTime(now - 5 * 3_600_000, now, at), '5 小时前');
  assert.equal(relativeTime(now - 3 * 86_400_000, now, at), '3 天前');
  assert.equal(relativeTime(now - 30 * 86_400_000, now, at), new Date(now - 30 * 86_400_000).toLocaleDateString());
});
