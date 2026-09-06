import test from 'node:test';
import assert from 'node:assert/strict';
import { importCanvasIfChanged, mirrorVersion, type MirrorDeps } from '../../src/components/agent/mirror';
import { hashCanvas } from '../../src/components/agent/binding';
import { AgentRequestError } from '../../src/infrastructure/api/AgentRequestError';
import type { AgentSession } from '../../src/infrastructure/api/AgentApi';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const canvas = (n: number) => ({ nodes: Array.from({ length: n }, (_, i) => ({ id: i })), links: [] }) as any;
const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: canvas(1), nodeCount: 1, createdAt: new Date(0), isValid: true, ...extra });
const now = new Date('2026-09-06T12:00:00.000Z');

function deps(list: Workflow[]): MirrorDeps & { added: Workflow[]; updated: Workflow[]; bound: unknown[] } {
  const save = (w: Workflow) => {
    const at = list.findIndex(existing => existing.id === w.id);
    if (at >= 0) list[at] = w; else list.push(w);
  };
  const d = {
    added: [] as Workflow[], updated: [] as Workflow[], bound: [] as unknown[],
    workflows: async () => list,
    add: async (w: Workflow) => { d.added.push(w); save(w); },
    update: async (w: Workflow) => { d.updated.push(w); save(w); },
    bind: async (sessionId: string, ref: unknown) => { d.bound.push({ sessionId, ref }); },
    now: () => now, id: () => 'new-id',
  };
  return d;
}

test('mirrorVersion updates the bound workflow with the version canvas and hash', async () => {
  const session: AgentSession = { id: 's1', name: '海报', version: 3, created: 0, workflow: { id: 'a', name: '海报' } };
  const d = deps([wf('a', { agent: { sessionId: 's1', mirroredVersion: 2, mirroredHash: hashCanvas(canvas(1)) } })]);
  const result = await mirrorVersion(session, 3, canvas(4), d);
  assert.equal(result.kind, 'updated');
  assert.equal(d.updated[0].nodeCount, 4);
  assert.equal(d.updated[0].modifiedAt?.toISOString(), now.toISOString());
  assert.deepEqual(d.updated[0].agent, { sessionId: 's1', mirroredVersion: 3, mirroredHash: hashCanvas(canvas(4)) });
  assert.equal((await mirrorVersion(session, 2, canvas(1), d)).kind, 'unchanged', 'older versions never overwrite');
  assert.equal((await mirrorVersion(session, 3, canvas(4), d)).kind, 'unchanged', 'the same version is not mirrored twice');
});

test('mirrorVersion ignores the version guard when the workflow belongs to another session', async () => {
  // The canvas still matches what session A mirrored, so there is no user edit to protect: session B takes it over.
  const other = wf('a', { agent: { sessionId: 'sA', mirroredVersion: 5, mirroredHash: hashCanvas(canvas(1)) } });
  const session: AgentSession = { id: 'sB', name: '海报', version: 1, created: 0, workflow: { id: 'a', name: '海报' } };
  const d = deps([other]);
  const result = await mirrorVersion(session, 1, canvas(2), d);
  assert.equal(result.kind, 'updated');
  assert.deepEqual(d.updated[0].agent, { sessionId: 'sB', mirroredVersion: 1, mirroredHash: hashCanvas(canvas(2)) });
});

test('mirrorVersion protects an edited canvas that another session mirrored, but adopts an unbound copy', async () => {
  const session: AgentSession = { id: 'sB', name: '海报', version: 1, created: 0, workflow: { id: 'a', name: '海报' } };
  const editedElsewhere = wf('a', { workflow_json: canvas(7), nodeCount: 7, agent: { sessionId: 'sA', mirroredVersion: 5, mirroredHash: hashCanvas(canvas(1)) } });
  const edited = deps([editedElsewhere]);
  assert.equal((await mirrorVersion(session, 1, canvas(2), edited)).kind, 'conflict');
  assert.equal(edited.updated.length, 0, 'the edit stays whoever owns the binding');
  // A copy re-downloaded from cloud on another device carries no binding at all; nothing to protect, so it is stamped.
  const fresh = deps([wf('a', { workflow_json: canvas(7), nodeCount: 7 })]);
  assert.equal((await mirrorVersion(session, 1, canvas(2), fresh)).kind, 'updated');
  assert.deepEqual(fresh.updated[0].agent, { sessionId: 'sB', mirroredVersion: 1, mirroredHash: hashCanvas(canvas(2)) });
});

test('mirrorVersion refuses to overwrite a canvas edited since the last mirror', async () => {
  const edited = wf('a', { workflow_json: canvas(7), nodeCount: 7, agent: { sessionId: 's1', mirroredVersion: 2, mirroredHash: hashCanvas(canvas(1)) } });
  const session: AgentSession = { id: 's1', name: '海报', version: 3, created: 0, workflow: { id: 'a', name: '海报' } };
  const d = deps([edited]);
  const result = await mirrorVersion(session, 3, canvas(4), d);
  assert.equal(result.kind, 'conflict');
  assert.equal(result.kind === 'conflict' ? result.workflow.id : '', 'a');
  assert.equal(d.updated.length, 0, 'the user edit stays; the next message imports it');
});

test('mirrorVersion creates and binds a workflow for a blank session, and reports a deleted binding', async () => {
  const blank: AgentSession = { id: 's2', name: '新工作流', version: 1, created: 0, preview: '生成一张猫' };
  const d = deps([]);
  const created = await mirrorVersion(blank, 1, canvas(2), d, { fallbackName: '新对话' });
  assert.equal(created.kind, 'created');
  assert.equal(d.added[0].id, 'new-id');
  assert.equal(d.added[0].name, '生成一张猫');
  assert.deepEqual(d.added[0].agent, { sessionId: 's2', mirroredVersion: 1, mirroredHash: hashCanvas(canvas(2)) });
  assert.deepEqual(d.bound[0], { sessionId: 's2', ref: { id: 'new-id', name: '生成一张猫' } });
  const missing: AgentSession = { id: 's3', name: 'x', version: 2, created: 0, workflow: { id: 'gone', name: 'x' } };
  assert.equal((await mirrorVersion(missing, 2, canvas(1), deps([]))).kind, 'missing');
  assert.equal((await mirrorVersion(missing, 2, canvas(1), deps([]), { recreate: true })).kind, 'created');
});

test('importCanvasIfChanged pushes edited canvases, skips clean ones and reports unsupported canvases', async () => {
  const clean = wf('a', { agent: { sessionId: 's1', mirroredVersion: 2, mirroredHash: hashCanvas(canvas(1)) } });
  const edited = { ...clean, workflow_json: canvas(3), nodeCount: 3 };
  const session: AgentSession = { id: 's1', name: '海报', version: 2, created: 0, workflow: { id: 'a', name: '海报' } };
  const calls: unknown[] = [];
  const ok = { importVersion: async (...args: unknown[]) => { calls.push(args); return { version: 3 }; }, setBinding: async (id: string, agent: unknown) => { calls.push({ id, agent }); } };
  assert.deepEqual(await importCanvasIfChanged(session, clean, ok), { kind: 'unchanged' });
  assert.deepEqual(await importCanvasIfChanged(session, undefined, ok), { kind: 'unchanged' });
  assert.deepEqual(await importCanvasIfChanged(session, edited, ok), { kind: 'imported', version: 3 });
  assert.deepEqual(calls[0], ['s1', edited.workflow_json, 2, '画布修改']);
  assert.deepEqual(calls[1], { id: 'a', agent: { sessionId: 's1', mirroredVersion: 3, mirroredHash: hashCanvas(edited.workflow_json) } });
  const otherSession = { ...clean, agent: { sessionId: 'sA', mirroredVersion: 9, mirroredHash: hashCanvas(canvas(1)) } };
  assert.deepEqual(await importCanvasIfChanged(session, otherSession, ok), { kind: 'imported', version: 3 }, 'a workflow taken over from another session is re-pushed');
  const unsupported = { ...ok, importVersion: async () => { throw new AgentRequestError(422, '工作流暂不支持或存在错误'); } };
  assert.deepEqual(await importCanvasIfChanged(session, edited, unsupported), { kind: 'unsupported', message: '工作流暂不支持或存在错误' });
  const rejected = { ...ok, importVersion: async () => { throw new AgentRequestError(400, '画布缺少必要字段'); } };
  assert.deepEqual(await importCanvasIfChanged(session, edited, rejected), { kind: 'unsupported', message: '画布缺少必要字段' }, 'a 400 is a canvas the agent cannot take, not a crash');
  const conflict = { ...ok, importVersion: async () => { throw new AgentRequestError(409, '版本已改变'); } };
  await assert.rejects(importCanvasIfChanged(session, edited, conflict), /版本已改变/);
});
