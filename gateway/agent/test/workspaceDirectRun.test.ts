import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentService } from '../service.js';
import { activeStates } from '../store.js';
import { AgentStore } from '../store.js';
import { WorkspaceComfy } from './workspaceFixture.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-direct-'));
  const adapter = new WorkspaceComfy(); adapter.complete = true;
  const config = { agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid',
    agentWorkspace: { directory: join(directory, 'media'), serverId: 'server' } };
  const service = new AgentService(config, { adapter }); // No language model configured.
  return { directory, adapter, config, service };
}

test('explicit canvas generation runs without a model and repeated requests retain one run and fixed seed', async () => {
  const { directory, adapter, service } = fixture();
  try {
    const session = await service.createSession('owner', 'Canvas');
    const runtime = service.workspace!; const repo = runtime.repository;
    const { draft } = runtime.workflows.create(session.id, { templateId: 'z-image-turbo', name: 'Image', text: 'cat', seed: 42 }, { requestId: randomUUID() }, adapter.info);
    const requestId = randomUUID();
    const task = service.enqueueWorkspaceRun(session.id, 'owner', requestId, draft.id, 1);
    assert.equal(task.workspace!.directRun, true);
    assert.equal(service.enqueueWorkspaceRun(session.id, 'owner', requestId, draft.id, 1).id, task.id);
    assert.throws(() => service.enqueueWorkspaceRun(session.id, 'other-owner', randomUUID(), draft.id, 1));
    assert.throws(() => service.enqueueWorkspaceRun(session.id, 'owner', randomUUID(), draft.id, 1), /当前任务/);
    for (let i = 0; i < 8 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
    const completed = service.store.task(task.id);
    assert.equal(completed.state, 'completed', JSON.stringify(completed));
    assert.equal(completed.steps, 0); assert.equal(completed.previews, 1);
    assert.deepEqual(completed.messages, []);
    assert.equal(adapter.submits, 1); assert.equal(repo.runs(session.id).items.length, 1);
    const run = repo.runs(session.id).items[0];
    assert.equal(run.revision, 1); assert.equal(run.state, 'succeeded');
    assert.ok(Object.values(run.executionSnapshot!.prompt).some(node => node.inputs.seed === 42 || node.inputs.noise_seed === 42));
    assert.equal(service.enqueueWorkspaceRun(session.id, 'owner', requestId, draft.id, 1).id, task.id);
    assert.equal(repo.runs(session.id).items.length, 1);
    // An explicit later click gets another Run, never an empty workflow revision.
    const again = service.enqueueWorkspaceRun(session.id, 'owner', randomUUID(), draft.id, 1);
    for (let i = 0; i < 8 && activeStates.includes(service.store.task(again.id).state); i++) await service.tick();
    assert.equal(adapter.submits, 2); assert.equal(repo.draft(session.id, draft.id).headRevision, 1);
    assert.equal(service.store.task(again.id).state, 'completed');
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('confirmed canvas run survives restart, and declining a second run never starts a model or GPU', async () => {
  const f = fixture(); let service = f.service;
  try {
    const session = await service.createSession('owner', 'Confirmation');
    const runtime = service.workspace!;
    const { draft } = runtime.workflows.create(session.id, { templateId: 'z-image-turbo', name: 'Image', text: 'cat' }, { requestId: randomUUID() }, f.adapter.info);
    runtime.repository.updateSession(session.id, { previewPolicy: 'confirm' });
    const task = service.enqueueWorkspaceRun(session.id, 'owner', randomUUID(), draft.id, 1);
    await service.tick();
    assert.equal(service.store.task(task.id).state, 'waiting_user'); assert.equal(f.adapter.submits, 0);
    const held = runtime.repository.runs(session.id).items[0];
    runtime.approve(session.id, task.id, held.id, held.approvalDigest!, true);
    await service.stop(); service = new AgentService(f.config, { adapter: f.adapter });
    for (let i = 0; i < 8 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
    assert.equal(service.store.task(task.id).state, 'completed'); assert.equal(f.adapter.submits, 1);
    const declined = service.enqueueWorkspaceRun(session.id, 'owner', randomUUID(), draft.id, 1);
    await service.tick();
    const next = service.workspace!.repository.runs(session.id).items[0];
    service.workspace!.approve(session.id, declined.id, next.id, next.approvalDigest!, false);
    await service.tick();
    assert.equal(service.store.task(declined.id).state, 'cancelled'); assert.equal(f.adapter.submits, 1);
    assert.equal(service.store.task(declined.id).steps, 0);
  } finally { await service.stop(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('direct generation failures terminate the explicit task and cannot reuse a chat request identity', async () => {
  const { directory, adapter, service } = fixture();
  try {
    const session = await service.createSession('owner', 'Invalid canvas'); const runtime = service.workspace!;
    const { draft } = runtime.workflows.create(session.id, { templateId: 'z-image-turbo', name: 'Image', text: 'cat' }, { requestId: randomUUID() }, adapter.info);
    const requestId = randomUUID();
    runtime.enqueue(session.id, requestId, '按指定工作流版本生成', { targetDraftId: draft.id, sourceRevision: 1, action: 'rerun' }, 60_000);
    assert.throws(() => service.enqueueWorkspaceRun(session.id, 'owner', requestId, draft.id, 1), /请求 ID/);
    service.cancel(session.id, 'owner', service.store.tasks(session.id)[0].id);
    adapter.info = {}; // Installed nodes disappeared after the draft was created.
    const task = service.enqueueWorkspaceRun(session.id, 'owner', randomUUID(), draft.id, 1);
    for (let i = 0; i < 5 && activeStates.includes(service.store.task(task.id).state); i++) await service.tick();
    assert.equal(service.store.task(task.id).state, 'failed'); assert.equal(service.store.task(task.id).steps, 0);
    assert.equal(adapter.submits, 0); assert.equal(runtime.repository.runs(session.id).items.length, 1);
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('failed atomic run registration leaves no task, operation or event behind', async () => {
  const { directory, adapter, service } = fixture();
  try {
    const session = await service.createSession('owner', 'Archived'); const runtime = service.workspace!;
    const { draft } = runtime.workflows.create(session.id, { templateId: 'z-image-turbo', name: 'Image', text: 'cat' }, { requestId: randomUUID() }, adapter.info);
    runtime.repository.updateDraft(session.id, draft.id, { archivedAt: Date.now() });
    const before = service.store.events(session.id);
    assert.throws(() => service.enqueueWorkspaceRun(session.id, 'owner', randomUUID(), draft.id, 1), /归档/);
    assert.equal(service.store.tasks(session.id).length, 0);
    assert.equal(runtime.repository.runs(session.id).items.length, 0);
    assert.equal(runtime.repository.db.prepare('SELECT COUNT(*) AS n FROM workspace_operations').get()!.n, 0);
    assert.deepEqual(service.store.events(session.id), before);
  } finally { await service.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test('nested store transactions roll back caught inner writes and roll back released children on outer failure', () => {
  const store = new AgentStore(':memory:');
  try {
    store.transaction(() => {
      store.setSetting('outer', 1);
      assert.throws(() => store.transaction(() => { store.setSetting('inner', 2); throw new Error('inner failure'); }));
      assert.equal(store.setting('inner'), undefined);
      store.setSetting('after', 3);
    });
    assert.equal(store.setting('outer'), 1); assert.equal(store.setting('after'), 3);
    assert.throws(() => store.transaction(() => {
      store.transaction(() => store.setSetting('child', 4));
      store.setSetting('outer', 99); throw new Error('outer failure');
    }));
    assert.equal(store.setting('child'), undefined); assert.equal(store.setting('outer'), 1);
    store.transaction(() => store.setSetting('healthy', true)); assert.equal(store.setting('healthy'), true);
  } finally { store.close(); }
});
