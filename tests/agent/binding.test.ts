import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasChangedSinceMirror, chooseDefaultTab, hashCanvas, resolveBoundWorkflow, sessionTitle } from '../../src/components/agent/binding';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: { nodes: [], links: [] } as any, nodeCount: 0, createdAt: new Date(0), isValid: true, ...extra });

test('resolveBoundWorkflow prefers id and falls back to the cloud filename', () => {
  const list = [wf('a'), wf('cloud_1', { cloud: { provider: 'comfyui', filename: '海报.json' } })];
  assert.equal(resolveBoundWorkflow({ id: 'a', name: 'a' }, list)?.id, 'a');
  assert.equal(resolveBoundWorkflow({ id: 'gone', name: 'x', filename: '海报.json' }, list)?.id, 'cloud_1');
  assert.equal(resolveBoundWorkflow({ id: 'gone', name: 'x' }, list), undefined);
  assert.equal(resolveBoundWorkflow(undefined, list), undefined);
});

test('hashCanvas ignores key order but not content', () => {
  assert.equal(hashCanvas({ a: 1, b: { c: 2, d: 3 } }), hashCanvas({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(hashCanvas({ a: 1, b: { c: 2, d: 3 } }), hashCanvas({ a: 1, b: { c: 2, d: 4 } }));
});

test('canvasChangedSinceMirror compares the canvas hash and the owning session', () => {
  const json = { nodes: [{ id: 1 }], links: [] } as any;
  const bind = (sessionId: string) => ({ sessionId, mirroredVersion: 2, mirroredHash: hashCanvas(json) });
  const same = wf('a', { workflow_json: json, agent: bind('s') });
  const edited = wf('a', { workflow_json: { nodes: [{ id: 1 }, { id: 2 }], links: [] } as any, agent: bind('s') });
  assert.equal(canvasChangedSinceMirror(same, 's'), false);
  assert.equal(canvasChangedSinceMirror(edited, 's'), true);
  assert.equal(canvasChangedSinceMirror(same, 'other'), true, 'a canvas mirrored by another session must be imported');
  assert.equal(canvasChangedSinceMirror(wf('a', { workflow_json: json }), 's'), false, 'unbound workflows never import');
});

test('chooseDefaultTab remembers the last tab, otherwise follows agent availability', () => {
  assert.equal(chooseDefaultTab('/outputs', true), '/outputs');
  assert.equal(chooseDefaultTab('/bogus', true), '/chats');
  assert.equal(chooseDefaultTab(null, true), '/chats');
  assert.equal(chooseDefaultTab(null, false), '/workflows');
  assert.equal(chooseDefaultTab('/chats', false), '/workflows');
});

test('sessionTitle uses the bound workflow name, then the first message, then the fallback', () => {
  assert.equal(sessionTitle({ workflow: { id: 'a', name: '海报' }, preview: '随便' }, '新对话'), '海报');
  assert.equal(sessionTitle({ preview: '现在能用哪些模型？' }, '新对话'), '现在能用哪些模型？');
  assert.equal(sessionTitle({}, '新对话'), '新对话');
});
