import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentStore } from '../store.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { backupDatabase, migrateLegacyWorkspace, planMigration } from '../workspace/migration.js';
import type { Asset, Run } from '../workspace/types.js';
import { textToImage } from '../templates.js';
import { info } from './fixture.js';

const canvas = (text = 'cat') => textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', text);
const request = () => ({ requestId: randomUUID() });
function fixture() {
  const store = new AgentStore(':memory:');
  const repository = new WorkspaceRepository(store);
  const session = store.create('owner', '创作');
  repository.initializeSession(session.id);
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
    const other = store.create('owner', 'Other'); repo.initializeSession(other.id);
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

test('migration preserves full old history, source evidence, duplicate output names and incomplete executions', () => {
  const store = new AgentStore(':memory:');
  const repo = new WorkspaceRepository(store);
  try {
    const session = store.create('owner', '旧会话', canvas());
    const empty = store.create('owner', '纯聊天');
    for (let version = 1; version < 105; version++) store.commitVersion(session.id, version, canvas(String(version)), 'old edit');
    const first = store.enqueue(session.id, randomUUID(), 'image', 60_000, [{ filename: 'upload.png', subfolder: 'agent-chat', type: 'input', kind: 'image' }]);
    store.update({ ...first, state: 'completed' });
    store.event(session.id, first.id, 'result', { success: true, version: 1, promptId: 'first', outputs: [
      { filename: 'same.png', subfolder: '', type: 'output', kind: 'image' }, { filename: 'same.png', subfolder: '', type: 'output', kind: 'image' },
    ] });
    const resultSeq = store.events(session.id).at(-1)!.seq;
    store.putReceipt(first.id, `output-image:${resultSeq}:0`, { filename: 'copied.png', subfolder: '', type: 'input' });
    for (let i = 0; i < 110; i++) { const task = store.enqueue(session.id, randomUUID(), 'later', 60_000); store.update({ ...task, state: 'completed' }); }
    const stopped = store.enqueue(session.id, randomUUID(), 'stopped', 60_000);
    store.update({ ...stopped, state: 'cancelled', execution: { attempt: 'uncertain-attempt', version: 105, submitted: 1 } });
    store.event(session.id, stopped.id, 'execution_error', { diagnostic: 'unknown old rejection' });
    const original = store.db.prepare('SELECT * FROM versions ORDER BY version').all();
    const originalEvents = store.db.prepare('SELECT * FROM events ORDER BY seq').all();
    const plan = planMigration(store.db);
    assert.equal(plan.tasks, 112);
    assert.deepEqual(plan.unresolvedTerminalExecutionIds, [stopped.id]);
    const migrated = migrateLegacyWorkspace(repo, 'original-server');
    assert.equal(migrated.revisions, 105);
    assert.equal(migrated.drafts, 1);
    assert.equal(migrated.runs, 2);
    assert.equal(migrated.assets, 3);
    assert.equal(migrated.incompleteEventSeqs.length, 1);
    const draft = repo.drafts(session.id).items[0];
    assert.equal(draft.headRevision, 105);
    assert.equal(draft.legacy, true);
    assert.equal(repo.revision(session.id, draft.id, 1).sourceRevision, undefined);
    assert.equal(repo.drafts(empty.id).items.length, 0);
    assert.equal('version' in repo.session(session.id), false);
    assert.deepEqual(store.db.prepare('SELECT * FROM versions ORDER BY version').all(), original);
    assert.deepEqual(store.db.prepare('SELECT * FROM events WHERE seq<=? ORDER BY seq').all(Number(originalEvents.at(-1)!.seq)), originalEvents);
    const images = repo.assets(session.id).items.filter(asset => asset.origin === 'generated');
    assert.equal(images.length, 2);
    assert.notEqual(images[0].id, images[1].id);
    assert.equal(images[0].blobDigest, undefined, 'do not claim old media bytes have been verified');
    assert.ok(images.some(asset => repo.locations(session.id, asset.id).some(location => location.role === 'input' && !location.verifiedDigest)));
    assert.ok(repo.runs(session.id).items.some(run => run.state === 'unknown' && run.submissionKey === 'uncertain-attempt'));
    assert.equal(migrateLegacyWorkspace(repo, 'original-server').alreadyMigrated, true);
    assert.equal(repo.assets(session.id).items.length, 3);
  } finally { store.close(); }
});

test('migration blocks active work and rolls back the entire conversion on inconsistent history', () => {
  const store = new AgentStore(':memory:'); const repo = new WorkspaceRepository(store);
  try {
    const session = store.create('owner', 'old', canvas());
    const task = store.enqueue(session.id, randomUUID(), 'active', 60_000);
    assert.throws(() => migrateLegacyWorkspace(repo, 'server'), /活动任务/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace_sessions').get()!.n, 0);
    store.update({ ...task, state: 'completed' });
    const corrupt = store.create('owner', 'corrupt', canvas());
    store.db.prepare('DELETE FROM versions WHERE session_id=?').run(corrupt.id);
    assert.throws(() => migrateLegacyWorkspace(repo, 'server'), /缺少工作流版本/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM drafts').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM workspace_sessions').get()!.n, 0);
    assert.equal(planMigration(store.db).alreadyMigrated, false);
  } finally { store.close(); }
});

test('consistent backup includes WAL data and is usable without the original database', t => {
  const folder = mkdtempSync(join(tmpdir(), 'workspace-migrate-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const store = new AgentStore(join(folder, 'agent.sqlite'));
  const session = store.create('owner', 'backup', canvas());
  const path = join(folder, 'before-workspace.sqlite');
  backupDatabase(store.db, path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => backupDatabase(store.db, path), /不会覆盖/);
  const repo = new WorkspaceRepository(store);
  migrateLegacyWorkspace(repo, 'server');
  store.close();
  const restored = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal((JSON.parse(String(restored.prepare('SELECT data FROM sessions WHERE id=?').get(session.id)!.data)) as { name: string }).name, 'backup');
    assert.equal(restored.prepare("SELECT name FROM sqlite_master WHERE name='workspace_migrations'").get(), undefined);
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM versions').get()!.n, 1);
  } finally { restored.close(); }
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
