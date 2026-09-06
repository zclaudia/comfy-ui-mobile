import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasChangedSinceMirror, chooseDefaultTab, resolveBoundWorkflow, sessionTitle } from '../../src/components/agent/binding';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: { nodes: [], links: [] } as any, nodeCount: 0, createdAt: new Date(0), isValid: true, ...extra });

test('resolveBoundWorkflow prefers id and falls back to the cloud filename', () => {
  const list = [wf('a'), wf('cloud_1', { cloud: { provider: 'comfyui', filename: '海报.json' } })];
  assert.equal(resolveBoundWorkflow({ id: 'a', name: 'a' }, list)?.id, 'a');
  assert.equal(resolveBoundWorkflow({ id: 'gone', name: 'x', filename: '海报.json' }, list)?.id, 'cloud_1');
  assert.equal(resolveBoundWorkflow({ id: 'gone', name: 'x' }, list), undefined);
  assert.equal(resolveBoundWorkflow(undefined, list), undefined);
});

test('canvasChangedSinceMirror compares modifiedAt with the mirrored stamp', () => {
  const at = '2026-09-06T10:00:00.000Z';
  const same = wf('a', { modifiedAt: new Date(at), agent: { sessionId: 's', mirroredVersion: 2, mirroredAt: at } });
  const later = wf('a', { modifiedAt: new Date('2026-09-06T10:05:00.000Z'), agent: { sessionId: 's', mirroredVersion: 2, mirroredAt: at } });
  assert.equal(canvasChangedSinceMirror(same), false);
  assert.equal(canvasChangedSinceMirror(later), true);
  assert.equal(canvasChangedSinceMirror(wf('a', { modifiedAt: new Date() })), false, 'unbound workflows never import');
});

test('chooseDefaultTab remembers the last tab, otherwise follows agent availability', () => {
  assert.equal(chooseDefaultTab('/outputs', true), '/outputs');
  assert.equal(chooseDefaultTab('/bogus', true), '/chats');
  assert.equal(chooseDefaultTab(null, true), '/chats');
  assert.equal(chooseDefaultTab(null, false), '/workflows');
});

test('sessionTitle uses the bound workflow name, then the first message, then the fallback', () => {
  assert.equal(sessionTitle({ name: '新工作流', workflow: { id: 'a', name: '海报' }, preview: '随便' }, '新对话'), '海报');
  assert.equal(sessionTitle({ name: '新工作流', preview: '现在能用哪些模型？' }, '新对话'), '现在能用哪些模型？');
  assert.equal(sessionTitle({ name: '新工作流' }, '新对话'), '新对话');
});
