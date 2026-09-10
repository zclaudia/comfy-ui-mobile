import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, renameSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { AgentStore } from '../store.js';
import { WorkspaceRuntime } from '../workspace/runtime.js';
import { WorkspaceCleanup } from '../workspace/cleanup.js';
import { WorkspaceComfy, mediaKey } from './workspaceFixture.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-cleanup-'));
  let store = new AgentStore(join(directory, 'agent.sqlite')); const adapter = new WorkspaceComfy();
  adapter.getWorkflow = async () => null;
  let runtime = new WorkspaceRuntime(store, adapter, { directory: join(directory, 'assets'), serverId: 'server', maxPreviews: 5 });
  let repo = runtime.repository; const session = repo.createSession('owner', 'Cleanup target');
  const upload = async (sid: string, color: string, filename = `${randomUUID()}.png`) => {
    const file = { filename, subfolder: 'original-user-files', type: 'input' as const, kind: 'image' as const };
    adapter.files.set(mediaKey(file), await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer());
    const asset = runtime.assets.registerUpload(sid, file, randomUUID()); return runtime.assets.capture(sid, asset.id);
  };
  return { directory, get store() { return store; }, adapter, get runtime() { return runtime; }, get repo() { return repo; }, session, upload,
    reopen: async () => {
      await runtime.assets.stop(); store.close();
      store = new AgentStore(join(directory, 'agent.sqlite'));
      runtime = new WorkspaceRuntime(store, adapter, { directory: join(directory, 'assets'), serverId: 'server', maxPreviews: 5 });
      repo = runtime.repository;
    },
    close: async () => { await runtime.assets.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('cleanup removes unreferenced records and blobs while keeping library provenance, shared bytes and original files', async () => {
  const f = fixture();
  try {
    const sid = f.session.id;
    const free = await f.upload(sid, 'red'); const shared = await f.upload(sid, 'blue');
    const other = f.repo.createSession('owner', 'Other chat'); const otherAsset = await f.upload(other.id, 'blue');
    assert.equal(shared.blobDigest, otherAsset.blobDigest);
    const task = f.store.enqueue(sid, randomUUID(), 'private old user message', 1000);
    f.store.update({ ...task, state: 'completed', messages: [{ role: 'user', content: 'private context' }] });
    const image = f.runtime.workflows.create(sid, { templateId: 'z-image-turbo', name: 'Source image', text: 'cat' }, { requestId: randomUUID() }, f.adapter.info);
    const runId = randomUUID(); f.repo.insertRun({ id: runId, taskId: task.id, sessionId: sid, draftId: image.draft.id, revision: 1, serverId: 'server', state: 'succeeded', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: 1 });
    const ref = { filename: 'original-output.png', subfolder: 'outputs', type: 'output' as const };
    f.adapter.files.set(mediaKey(ref), await sharp({ create: { width: 16, height: 16, channels: 3, background: 'green' } }).png().toBuffer());
    const generated = f.runtime.assets.registerOutputs(sid, runId, { '9': { images: [ref, ref] } });
    for (const id of generated.outputAssetIds) await f.runtime.assets.capture(sid, id);
    const video = f.runtime.workflows.create(sid, { templateId: 'h3-ref-image', name: 'Library video', text: 'wave', references: [{ nodeId: '17', inputName: 'image', assetId: generated.outputAssetIds[0] }] }, { requestId: randomUUID() }, f.adapter.info);
    const intent = f.runtime.library.begin(sid, video.draft.id, { requestId: randomUUID(), revision: 1, mode: 'create', startedBy: 'test', target: { serverId: 'server', workflowId: randomUUID(), filename: 'retained-video.json', name: 'Library video' } });
    const prepared = await f.runtime.library.prepare(sid, intent.id, new AbortController().signal);
    f.runtime.library.applying(sid, intent.id); f.adapter.getWorkflow = async () => ({ content: prepared.content!, etag: 'verified' });
    await f.runtime.library.reconcile(sid, intent.id, new AbortController().signal);
    const rawFiles = new Map([...f.adapter.files].map(([key, bytes]) => [key, Buffer.from(bytes)])); const pins = f.repo.db.prepare('SELECT * FROM library_asset_refs').all();
    assert.ok((await f.runtime.cleanup.preview(sid)).plan.blockers.includes('请先归档会话再清理'));
    f.repo.updateSession(sid, { archivedAt: Date.now() });
    const { plan } = await f.runtime.cleanup.preview(sid);
    assert.equal(plan.retained.assets, 2, 'the complete source batch and its origin stay with the pinned library image');
    assert.equal(plan.retained.drafts, 2); assert.equal(plan.retained.runs, 1); assert.ok(plan.reclaimableBytes > 0);
    const requestId = randomUUID(); const result = await f.runtime.cleanup.execute(sid, requestId, plan.token);
    assert.equal(result.state, 'completed'); assert.equal(f.repo.session(sid).deletedAt, result.created);
    assert.equal(f.store.events(sid).length, 0); assert.equal(f.store.task(task.id).message, ''); assert.deepEqual(f.store.task(task.id).messages, []);
    assert.throws(() => f.repo.asset(sid, free.id)); assert.throws(() => f.repo.asset(sid, shared.id));
    assert.equal(existsSync(join(f.runtime.assets.options.directory, `${free.blobDigest}.blob`)), false);
    assert.equal((await f.runtime.assets.read(other.id, otherAsset.id)).asset.blobDigest, shared.blobDigest);
    for (const id of generated.outputAssetIds) assert.equal((await f.runtime.assets.read(sid, id)).asset.captureState, 'ready');
    assert.deepEqual(f.adapter.files, rawFiles, 'ComfyUI inputs, output files and user uploads are untouched');
    assert.deepEqual(f.repo.db.prepare('SELECT * FROM library_asset_refs').all(), pins);
    assert.deepEqual(f.repo.revision(sid, video.draft.id, 1), video.revision);
    assert.deepEqual(f.repo.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(await f.runtime.cleanup.execute(sid, requestId, plan.token), result);
    assert.throws(() => f.repo.updateSession(sid, { archivedAt: null }), /已清理/);
    assert.throws(() => f.repo.commitRevision(sid, image.draft.id, { expectedHeadRevision: 1, sourceRevision: 1, canvas: image.revision.canvas, bindings: [], summary: 'late save' }, { requestId: randomUUID() }), /已清理/);
    assert.equal(f.adapter.submits, 0);
  } finally { await f.close(); }
});

test('cleanup checks the reviewed fingerprint and blocks uncertain generation or unfinished file operations', async () => {
  const f = fixture();
  try {
    await f.upload(f.session.id, 'red'); f.repo.updateSession(f.session.id, { archivedAt: Date.now() });
    const before = await f.runtime.cleanup.preview(f.session.id);
    f.repo.updateSession(f.session.id, { name: 'Changed after review' });
    await assert.rejects(f.runtime.cleanup.execute(f.session.id, randomUUID(), before.plan.token), /重新查看清理影响/);
    assert.equal(f.repo.session(f.session.id).deletedAt, undefined);
    f.repo.updateSession(f.session.id, { archivedAt: null });
    const draft = f.runtime.workflows.create(f.session.id, { templateId: 'z-image-turbo', name: 'Unknown run', text: 'cat' }, { requestId: randomUUID() }, f.adapter.info).draft;
    f.repo.insertRun({ id: randomUUID(), sessionId: f.session.id, draftId: draft.id, revision: 1, serverId: 'server', state: 'unknown', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: 1 });
    f.repo.updateSession(f.session.id, { archivedAt: Date.now() });
    const next = await f.runtime.cleanup.preview(f.session.id); assert.ok(next.plan.blockers.includes('仍有生成结果尚未确认，暂不能清理'));
    await assert.rejects(f.runtime.cleanup.execute(f.session.id, randomUUID(), next.plan.token), /尚未确认/);
    assert.equal(f.repo.assets(f.session.id).items.length, 1);
  } finally { await f.close(); }
});

test('file removal failure survives closing and reopening SQLite and resumes without deleting records again', async () => {
  const f = fixture();
  try {
    const asset = await f.upload(f.session.id, 'purple'); f.repo.updateSession(f.session.id, { archivedAt: Date.now() });
    const broken = new WorkspaceCleanup(f.repo, f.runtime.assets, f.runtime.library, async () => { throw new Error('disk failure'); });
    const { plan } = await broken.preview(f.session.id); const requestId = randomUUID();
    const first = await broken.execute(f.session.id, requestId, plan.token);
    assert.equal(first.state, 'deleting_files'); assert.equal(first.files[0].state, 'failed');
    assert.equal(f.repo.assets(f.session.id).items.length, 0); assert.ok(existsSync(join(f.runtime.assets.options.directory, `${asset.blobDigest}.blob`)));
    await f.reopen();
    const restarted = f.runtime.cleanup;
    assert.deepEqual((await restarted.preview(f.session.id)).operation, first);
    await assert.rejects(restarted.execute(f.session.id, randomUUID(), plan.token), /原清理操作/);
    const result = await restarted.execute(f.session.id, requestId, plan.token);
    assert.equal(result.state, 'completed'); assert.equal(result.files[0].state, 'removed');
    assert.equal(existsSync(join(f.runtime.assets.options.directory, `${asset.blobDigest}.blob`)), false);
    assert.deepEqual(f.repo.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { await f.close(); }
});

test('cleanup never follows a blob symlink or deletes its target', async () => {
  const f = fixture();
  try {
    const asset = await f.upload(f.session.id, 'orange');
    const path = join(f.runtime.assets.options.directory, `${asset.blobDigest}.blob`);
    const external = join(f.directory, 'external-user-file.png'); renameSync(path, external); symlinkSync(external, path);
    const original = readFileSync(external);
    f.repo.updateSession(f.session.id, { archivedAt: Date.now() });
    const { plan } = await f.runtime.cleanup.preview(f.session.id);
    assert.equal(plan.unknownBlobs, 1); assert.equal(plan.reclaimableBytes, 0);
    const result = await f.runtime.cleanup.execute(f.session.id, randomUUID(), plan.token);
    assert.equal(result.state, 'completed'); assert.deepEqual(result.files, []);
    assert.ok(existsSync(path)); assert.deepEqual(readFileSync(external), original);
  } finally { await f.close(); }
});
