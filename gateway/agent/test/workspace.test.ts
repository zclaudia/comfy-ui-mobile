import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AgentStore } from '../store.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import type { Asset, Run } from '../workspace/types.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const canvas = (text = 'cat') => textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', text);
const request = () => ({ requestId: randomUUID() });
function fixture() {
  const store = new AgentStore(':memory:');
  const repository = new WorkspaceRepository(store);
  const session = repository.createSession('owner', '创作');
  return { store, repository, session };
}
function uploaded(sessionId: string): Asset {
  return { id: randomUUID(), sessionId, kind: 'image', name: 'cat.png', origin: 'uploaded', displayOrdinal: 1,
    captureState: 'pending_capture', metadata: {}, created: Date.now() };
}

test('drafts advance independently, preserve historical edit parents and fork without moving source head', () => {
  const { store, repository: repo, session } = fixture();
  try {
    const a = repo.createDraft(session.id, { name: '图片', canvas: canvas(), outputKinds: ['image'] }, request());
    const b = repo.createDraft(session.id, { name: '视频方案', canvas: canvas('video'), outputKinds: ['video', 'audio'] }, request());
    let head = 1;
    while (head < 5) {
      const revision = repo.commitRevision(session.id, a.draft.id, { expectedHeadRevision: head, sourceRevision: head, canvas: canvas(String(head)), bindings: [], summary: 'edit' }, request());
      head = revision.revision;
    }
    const old = repo.revision(session.id, a.draft.id, 2);
    const next = repo.commitRevision(session.id, a.draft.id, { expectedHeadRevision: 5, sourceRevision: 2, canvas: old.canvas, bindings: [], summary: 'from second' }, request());
    assert.equal(next.revision, 6);
    assert.equal(next.sourceRevision, 2);
    assert.equal(next.previousHeadRevision, 5);
    assert.equal(repo.draft(session.id, b.draft.id).headRevision, 1);
    assert.equal(repo.revisions(session.id, a.draft.id).items.length, 6);
    const fork = repo.fork(session.id, a.draft.id, 2, '另一方向', request());
    assert.deepEqual(fork.draft.forkedFrom, { draftId: a.draft.id, revision: 2 });
    assert.deepEqual(fork.revision.canvas, old.canvas);
    assert.equal(repo.draft(session.id, a.draft.id).headRevision, 6);
    assert.throws(() => repo.commitRevision(session.id, a.draft.id, { expectedHeadRevision: 5, sourceRevision: 2, canvas: old.canvas, bindings: [], summary: 'stale' }, request()), /新版本/);
    assert.throws(() => store.db.prepare('UPDATE draft_revisions SET data=data WHERE draft_id=?').run(a.draft.id), /immutable/);
    assert.deepEqual(repo.revision(session.id, a.draft.id, 2), old);
  } finally { store.close(); }
});

test('request and operation identities survive retries, enforce dependencies and reject parameter changes', () => {
  const { store, repository: repo, session } = fixture();
  try {
    const identity = request();
    const input = { name: '图', canvas: canvas(), outputKinds: ['image' as const] };
    const created = repo.createDraft(session.id, input, identity);
    assert.deepEqual(repo.createDraft(session.id, input, identity), created);
    assert.throws(() => repo.createDraft(session.id, { ...input, name: 'different' }, identity), /请求 ID/);
    const task = store.enqueue(session.id, randomUUID(), 'test', 60_000);
    store.update({ ...task, state: 'running' });
    const plans = [ { stepKey: 'new-image', kind: 'create_workflow' as const },
      { stepKey: 'edit', kind: 'edit_workflow' as const, targetDraftId: created.draft.id, dependsOn: ['new-image'] } ];
    const [create, edit] = repo.plan(session.id, task.id, plans);
    assert.deepEqual(repo.plan(session.id, task.id, plans).map(op => op.id), [create.id, edit.id]);
    const editInput = { expectedHeadRevision: 1, sourceRevision: 1, canvas: canvas('changed'), bindings: [], summary: 'change' };
    assert.throws(() => repo.commitRevision(session.id, created.draft.id, editInput, { taskId: task.id, operationId: edit.id }), /前置/);
    const actual = repo.createDraft(session.id, input, { taskId: task.id, operationId: create.id });
    assert.deepEqual(repo.createDraft(session.id, input, { taskId: task.id, operationId: create.id }), actual);
    const edited = repo.commitRevision(session.id, created.draft.id, editInput, { taskId: task.id, operationId: edit.id });
    assert.equal(edited.revision, 2);
    assert.equal(repo.operations(session.id, task.id).filter(op => op.state === 'completed').length, 2);
    assert.throws(() => repo.createDraft(session.id, input, request()), /当前任务/);
    const [bad] = repo.plan(session.id, task.id, [{ stepKey: 'stale', kind: 'edit_workflow', targetDraftId: created.draft.id }]);
    assert.throws(() => repo.commitRevision(session.id, created.draft.id, editInput, { taskId: task.id, operationId: bad.id }), /新版本/);
    assert.equal(repo.operation(session.id, bad.id).state, 'failed');
    assert.throws(() => repo.commitRevision(session.id, created.draft.id, { ...editInput, expectedHeadRevision: 2 }, { taskId: task.id, operationId: bad.id }), /不同参数/);
    assert.equal(repo.draft(session.id, created.draft.id).headRevision, 2);
    assert.throws(() => repo.plan(session.id, task.id, [{ stepKey: 'loop', kind: 'create_workflow', dependsOn: ['loop'] }]), /前置/);
  } finally { store.close(); }
});

test('cross-session drafts, revisions, asset bindings, tasks and runs cannot be confused', () => {
  const { store, repository: repo, session } = fixture();
  try {
    const other = repo.createSession('owner', 'Other');
    const foreign = repo.createDraft(other.id, { name: 'foreign', canvas: canvas(), outputKinds: ['image'] }, request());
    const asset = repo.registerAsset(uploaded(other.id));
    assert.throws(() => repo.draft(session.id, foreign.draft.id), /找不到/);
    assert.throws(() => repo.validateContext(session.id, { targetDraftId: foreign.draft.id }), /找不到/);
    assert.throws(() => repo.validateContext(session.id, { selectedAssetIds: [asset.id] }), /找不到/);
    assert.throws(() => repo.validateContext(session.id, { sourceRevision: 1 }), /需要指定/);
    assert.throws(() => repo.fork(session.id, foreign.draft.id, 1, 'copy', request()), /找不到/);
    const withLoader = canvas(); withLoader.nodes.push({ id: 99, type: 'LoadImage', pos: [0, 0], size: [100, 100], flags: {}, order: 99, mode: 0, inputs: [], outputs: [], properties: {}, widgets_values: ['cat.png'] });
    assert.throws(() => repo.createDraft(session.id, { name: 'bad', canvas: withLoader, outputKinds: ['image'], bindings: [{ id: 'ref', nodeId: '99', inputName: 'image', role: 'reference_image', assetId: asset.id }] }, request()), /找不到/);
    assert.equal(repo.drafts(session.id).items.length, 0, 'failed binding rolls back the whole draft');
    assert.throws(() => repo.insertRun({ id: randomUUID(), sessionId: session.id, draftId: foreign.draft.id, revision: 1, serverId: 'comfy', state: 'preparing', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: 1 }), /找不到/);
    assert.throws(() => store.db.prepare('INSERT INTO draft_revisions VALUES(?,?,?,?)').run(foreign.draft.id, 2, session.id, '{}'), /FOREIGN KEY/);
  } finally { store.close(); }
});

test('pagination reaches all old revisions and assets; asset content identity cannot be rewritten', () => {
  const { store, repository: repo, session } = fixture();
  try {
    const a = repo.createDraft(session.id, { name: 'many', canvas: canvas(), outputKinds: ['image'] }, request());
    for (let i = 1; i <= 120; i++) {
      repo.commitRevision(session.id, a.draft.id, { expectedHeadRevision: i, sourceRevision: i, canvas: canvas(String(i)), bindings: [], summary: 'edit' }, request());
      repo.registerAsset(uploaded(session.id));
    }
    const revisions: number[] = [], assets: string[] = [];
    let before: number | undefined;
    do { const page = repo.revisions(session.id, a.draft.id, { before, limit: 17 }); revisions.push(...page.items.map(v => v.revision)); before = page.nextCursor; } while (before);
    do { const page = repo.assets(session.id, { before, limit: 17 }); assets.push(...page.items.map(a => a.id)); before = page.nextCursor; } while (before);
    assert.equal(new Set(revisions).size, 121);
    assert.equal(revisions.at(-1), 1);
    assert.equal(new Set(assets).size, 120);
    repo.updateAsset(session.id, assets[0], { captureState: 'ready', blobDigest: 'a'.repeat(64) });
    assert.throws(() => repo.updateAsset(session.id, assets[0], { blobDigest: 'b'.repeat(64) }), /不可改写/);
    assert.throws(() => repo.updateAsset(session.id, assets[1], { captureState: 'ready' }), /摘要/);
  } finally { store.close(); }
});

test('run and generated asset identities prevent duplicate polling inserts', () => {
  const { store, repository: repo, session } = fixture();
  try {
    const draft = repo.createDraft(session.id, { name: 'image', canvas: canvas(), outputKinds: ['image'] }, request()).draft;
    const run: Run = { id: randomUUID(), sessionId: session.id, draftId: draft.id, revision: 1, serverId: 'server', state: 'succeeded', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: 1 };
    repo.insertRun(run);
    assert.throws(() => repo.insertRun({ ...run, id: randomUUID() }), /UNIQUE/);
    const asset: Asset = { ...uploaded(session.id), origin: 'generated', sourceRunId: run.id, outputLocator: '7.images.0' };
    repo.registerAsset(asset);
    assert.equal(repo.registerAsset({ ...asset, id: randomUUID() }).id, asset.id);
    assert.equal(repo.assets(session.id).items.length, 1);
  } finally { store.close(); }
});

test('planning rejects future draft targets atomically, then accepts generation after creation returns its identity', () => {
  const { store, repository: repo, session } = fixture();
  try {
    const task = store.enqueue(session.id, randomUUID(), 'create then generate', 60_000);
    store.update({ ...task, state: 'running' });
    assert.throws(() => repo.plan(session.id, task.id, [
      { stepKey: 'create', kind: 'create_workflow' },
      { stepKey: 'generate', kind: 'submit_preview', dependsOn: ['create'] },
    ]), /取得返回的 draftId/);
    assert.deepEqual(repo.operations(session.id, task.id), [], 'invalid later steps must roll back the entire plan');
    assert.equal(repo.drafts(session.id).items.length, 0);
    for (const kind of ['edit_workflow', 'fork_workflow', 'replace_workflow_template', 'restore_workflow'] as const) {
      assert.throws(() => repo.plan(session.id, task.id, [{ stepKey: kind, kind }]), /targetDraftId/);
    }
    const [create] = repo.plan(session.id, task.id, [{ stepKey: 'create', kind: 'create_workflow' }]);
    const created = repo.createDraft(session.id, { name: 'cat', canvas: canvas(), outputKinds: ['image'] }, { taskId: task.id, operationId: create.id });
    const plans = [{ stepKey: 'generate', kind: 'submit_preview' as const, targetDraftId: created.draft.id, dependsOn: ['create'] }];
    const [generate] = repo.plan(session.id, task.id, plans);
    assert.deepEqual(JSON.parse(JSON.stringify(generate)), repo.plan(session.id, task.id, plans)[0]);
    assert.equal(generate.targetDraftId, created.draft.id);
    assert.throws(() => repo.plan(session.id, task.id, [{ stepKey: 'wrong-create', kind: 'create_workflow', targetDraftId: created.draft.id }]), /不能指定已有/);
    assert.equal(repo.operations(session.id, task.id).length, 2);
    assert.equal(repo.runs(session.id).items.length, 0);
  } finally { store.close(); }
});
