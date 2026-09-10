import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { AgentStore } from '../store.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { WorkspaceWorkflows } from '../workspace/workflows.js';
import { WorkspaceSelections } from '../workspace/selections.js';
import { canonicalCanvas } from '../workspace/compiler.js';
import { canvasToPrompt } from '../../workflow/canvas.js';
import type { ObjectInfo } from '../../workflow/engine.js';

function setup() {
  const store = new AgentStore(':memory:'); const repo = new WorkspaceRepository(store);
  const session = store.create('owner', 'creative'); repo.initializeSession(session.id);
  const info: ObjectInfo = JSON.parse(readFileSync(new URL('./model-fixtures/object-info.json', import.meta.url), 'utf8'));
  const workflows = new WorkspaceWorkflows(repo); const selections = new WorkspaceSelections(repo);
  const image = (name: string) => repo.registerAsset({ id: randomUUID(), sessionId: session.id, kind: 'image', name, origin: 'uploaded', displayOrdinal: 1, captureState: 'ready', blobDigest: 'a'.repeat(64), metadata: {}, created: Date.now() });
  const createImage = () => workflows.create(session.id, { templateId: 'z-image-turbo', name: 'cat', text: 'cat' }, { requestId: randomUUID() }, info);
  return { store, repo, session, info, workflows, selections, image, createImage };
}

test('workflow service preserves separate image/video revisions and changes only the requested reference', () => {
  const f = setup();
  try {
    const a = f.createImage(); const i1 = f.image('original'); const i2 = f.image('beach');
    const b = f.workflows.create(f.session.id, { templateId: 'h3-ref-image', name: 'waving', text: 'cat waves', seed: 123, references: [{ nodeId: '17', inputName: 'image', assetId: i1.id }] }, { requestId: randomUUID() }, f.info);
    const a2 = f.workflows.edit(f.session.id, { draftId: a.draft.id, expectedHeadRevision: 1, sourceRevision: 1, summary: 'beach', operations: [{ op: 'set_input', nodeId: '5', input: 'text', value: 'cat on beach' }] }, { requestId: randomUUID() }, f.info);
    assert.equal(a2.revision.revision, 2);
    assert.equal(f.repo.draft(f.session.id, b.draft.id).headRevision, 1);
    assert.equal(f.repo.revision(f.session.id, b.draft.id, 1).bindings[0].assetId, i1.id);
    const b2 = f.workflows.edit(f.session.id, { draftId: b.draft.id, expectedHeadRevision: 1, sourceRevision: 1, summary: 'new picture', bindingChanges: [{ nodeId: '17', inputName: 'image', assetId: i2.id }] }, { requestId: randomUUID() }, f.info);
    const before = canvasToPrompt(b.revision.canvas, f.info, false); const after = canvasToPrompt(b2.revision.canvas, f.info, false);
    assert.equal(b2.revision.bindings[0].id, b.revision.bindings[0].id);
    assert.equal(b2.revision.bindings[0].assetId, i2.id);
    before['17'].inputs.image = after['17'].inputs.image;
    assert.deepEqual(after, before, 'motion, dimensions, seed and all other video settings remain exact');
    assert.equal(f.repo.drafts(f.session.id).items.length, 2);
    assert.equal(f.repo.runs(f.session.id).items.length, 0, 'editing never submits implicitly');
  } finally { f.store.close(); }
});

test('editing an old result checks current head separately and command retries return the same version', () => {
  const f = setup();
  try {
    const a = f.createImage();
    const requestId = randomUUID();
    const edit = { draftId: a.draft.id, expectedHeadRevision: 1, sourceRevision: 1, summary: 'sunset', operations: [{ op: 'set_input' as const, nodeId: '5', input: 'text', value: 'sunset cat' }] };
    f.workflows.edit(f.session.id, edit, { requestId }, f.info);
    const third = f.workflows.edit(f.session.id, { ...edit, expectedHeadRevision: 2, operations: [{ op: 'set_input', nodeId: '7', input: 'width', value: 512 }] }, { requestId: randomUUID() }, f.info).revision;
    assert.equal(third.sourceRevision, 1); assert.equal(third.previousHeadRevision, 2); assert.equal(third.revision, 3);
    assert.equal(canvasToPrompt(third.canvas, f.info, false)['5'].inputs.text, 'cat');
    assert.equal(f.workflows.edit(f.session.id, edit, { requestId }, {}).revision.revision, 2, 'retry does not consult the changed environment');
    assert.throws(() => f.workflows.edit(f.session.id, { ...edit, summary: 'different' }, { requestId }, f.info), /ID/);
    assert.throws(() => f.workflows.edit(f.session.id, edit, { requestId: randomUUID() }, f.info), /新版本 3/);
  } finally { f.store.close(); }
});

test('unbound references remain editable and raw path patches cannot bypass bindings', () => {
  const f = setup();
  try {
    const b = f.workflows.create(f.session.id, { templateId: 'h3-ref-image', name: 'video', text: 'wave' }, { requestId: randomUUID() }, f.info);
    assert.equal(b.diagnostics[0].code, 'unbound_asset');
    const validation = f.workflows.validate(f.session.id, b.draft.id, 1, f.info);
    assert.equal(validation.editable, true); assert.equal(validation.executable, false);
    const edit = { draftId: b.draft.id, sourceRevision: 1, expectedHeadRevision: 1, summary: 'reference' };
    assert.throws(() => f.workflows.edit(f.session.id, { ...edit, operations: [{ op: 'set_input', nodeId: '17', input: 'image', value: 'ref_cat.png' }] }, { requestId: randomUUID() }, f.info), /绑定/);
    const bound = f.workflows.edit(f.session.id, { ...edit, bindingChanges: [{ nodeId: '17', inputName: 'image', assetId: f.image('cat').id }] }, { requestId: randomUUID() }, f.info).revision;
    assert.equal(f.workflows.validate(f.session.id, b.draft.id, 2, f.info).executable, true);
    const canvas = structuredClone(bound.canvas); canvas.nodes.find(node => node.id === 17)!.widgets_values![0] = 'different.png';
    assert.throws(() => f.workflows.saveCanvas(f.session.id, { ...edit, sourceRevision: 2, expectedHeadRevision: 2, canvas, bindings: bound.bindings }, { requestId: randomUUID() }, f.info), /disagree/);
    const repaired = canonicalCanvas(canvas, bound.bindings);
    assert.equal(f.workflows.saveCanvas(f.session.id, { ...edit, sourceRevision: 2, expectedHeadRevision: 2, canvas: repaired, bindings: bound.bindings }, { requestId: randomUUID() }, f.info).revision.revision, 3);
    assert.throws(() => f.workflows.edit(f.session.id, { ...edit, sourceRevision: 3, expectedHeadRevision: 3, operations: [{ op: 'set_input', nodeId: '1', input: 'unet_name', value: 'missing.gguf' }] }, { requestId: randomUUID() }, f.info), /Unavailable value/);
  } finally { f.store.close(); }
});

test('failed workflow commands persist their identity and require a separate repair step', () => {
  const f = setup();
  try {
    const task = f.store.enqueue(f.session.id, randomUUID(), 'video', 60_000); f.store.update({ ...task, state: 'running' });
    const [op] = f.repo.plan(f.session.id, task.id, [{ stepKey: 'video', kind: 'create_workflow' }]);
    const identity = { taskId: task.id, operationId: op.id };
    const input = { templateId: 'h3-ref-image', name: 'video', text: 'wave', frames: 24 };
    assert.throws(() => f.workflows.create(f.session.id, input, identity, f.info));
    assert.equal(f.repo.operation(f.session.id, op.id).state, 'failed');
    assert.throws(() => f.workflows.create(f.session.id, { ...input, frames: 22 }, identity, f.info), /不同参数/);
    assert.equal(f.repo.drafts(f.session.id).items.length, 0);
    const [repair] = f.repo.plan(f.session.id, task.id, [{ stepKey: 'repair-video', kind: 'create_workflow', repairOf: 'video' }]);
    assert.equal(repair.repairOf, op.id);
    f.workflows.create(f.session.id, { ...input, frames: 22 }, { taskId: task.id, operationId: repair.id }, f.info);
    assert.equal(f.repo.drafts(f.session.id).items.length, 1);
  } finally { f.store.close(); }
});

test('selection survives service restart, rejects cross-task and stale answers, and resumes exactly the paused task', () => {
  const f = setup();
  try {
    const a = f.createImage(); const i = f.image('cat');
    const context = { targetDraftId: a.draft.id, sourceRevision: 1, selectedAssetIds: [i.id] };
    const requestId = randomUUID();
    const task = f.store.enqueue(f.session.id, requestId, 'adjust', 60_000, [], undefined, { schemaVersion: 2, requestContext: context });
    assert.throws(() => f.store.enqueue(f.session.id, requestId, 'adjust', 60_000, [], undefined, { schemaVersion: 2, requestContext: {} }), /ID/);
    f.store.update({ ...task, state: 'running' });
    const request = { requestId: 'choose-source', question: 'Which image?', candidates: [{ type: 'asset' as const, assetId: i.id }, { type: 'draft' as const, draftId: a.draft.id, revision: 1 }] };
    const question = f.selections.request(f.session.id, task.id, request);
    assert.equal(f.selections.request(f.session.id, task.id, request).id, question.id);
    assert.equal(f.store.task(task.id).state, 'waiting_user');
    assert.throws(() => f.selections.answer(f.session.id, task.id, question.id, { selectedIndices: [5] }), /不存在/);
    const restarted = new WorkspaceSelections(f.repo);
    restarted.answer(f.session.id, task.id, question.id, { selectedIndices: [0], answer: 'original cat' });
    assert.equal(f.store.task(task.id).state, 'queued');
    assert.equal(f.store.task(task.id).workspace?.waitingReason, undefined);
    assert.deepEqual(f.store.task(task.id).workspace?.requestContext, context);
    assert.match(String(f.store.task(task.id).messages.at(-1)?.content), new RegExp(i.id));
    assert.throws(() => restarted.answer(f.session.id, task.id, question.id, { selectedIndices: [1] }), /过期/);
    assert.equal(f.repo.runs(f.session.id).items.length, 0);
  } finally { f.store.close(); }
});

test('selection cancellation and foreign candidates cannot write or resume a different conversation', () => {
  const f = setup();
  try {
    const other = f.store.create('owner', 'other'); f.repo.initializeSession(other.id);
    const draft = f.workflows.create(other.id, { templateId: 'z-image-turbo', name: 'other', text: 'dog' }, { requestId: randomUUID() }, f.info);
    const task = f.store.enqueue(f.session.id, randomUUID(), 'choose', 60_000, [], undefined, { schemaVersion: 2, requestContext: {} }); f.store.update({ ...task, state: 'running' });
    assert.throws(() => f.selections.request(f.session.id, task.id, { requestId: 'foreign', question: 'Which?', candidates: [{ type: 'draft', draftId: draft.draft.id }] }), /找不到/);
    const question = f.selections.request(f.session.id, task.id, { requestId: 'clarify', question: 'Describe the edit', candidates: [] });
    f.store.update({ ...f.store.task(task.id), state: 'cancelled' }); f.selections.cancelForTask(f.session.id, task.id);
    assert.equal(f.selections.get(f.session.id, question.id).state, 'cancelled');
    assert.throws(() => f.selections.answer(f.session.id, task.id, question.id, { selectedIndices: [], answer: 'beach' }), /过期/);
  } finally { f.store.close(); }
});

test('forking unsynchronized canvas preserves its actual content and historical source without advancing the original', () => {
  const f = setup();
  try {
    const original = f.createImage();
    f.workflows.edit(f.session.id, { draftId: original.draft.id, sourceRevision: 1, expectedHeadRevision: 1, summary: 'other device', operations: [{ op: 'set_input', nodeId: '5', input: 'text', value: 'other direction' }] }, { requestId: randomUUID() }, f.info);
    const local = structuredClone(original.revision.canvas); local.nodes.find(node => node.id === 5)!.widgets_values![0] = 'my unsynchronized edit';
    const input = { draftId: original.draft.id, sourceRevision: 1, name: 'my direction', canvas: local, bindings: [] };
    const identity = { requestId: randomUUID() };
    const fork = f.workflows.forkCanvas(f.session.id, input, identity, f.info);
    assert.equal(f.repo.draft(f.session.id, original.draft.id).headRevision, 2);
    assert.deepEqual(fork.draft.forkedFrom, { draftId: original.draft.id, revision: 1 });
    assert.deepEqual(fork.revision.canvas, local); assert.equal(fork.revision.revision, 1);
    assert.deepEqual(f.workflows.forkCanvas(f.session.id, input, identity, f.info), fork);
    assert.throws(() => f.workflows.forkCanvas(f.session.id, { ...input, name: 'changed retry' }, identity, f.info), /请求 ID/);
    assert.equal(f.repo.runs(f.session.id).items.length, 0);
    const other = f.repo.createSession('owner', 'different');
    assert.throws(() => f.workflows.forkCanvas(other.id, input, { requestId: randomUUID() }, f.info), /找不到/);
  } finally { f.store.close(); }
});
