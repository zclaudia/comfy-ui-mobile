import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { AgentStore } from '../store.js';
import { WorkspaceRuntime } from '../workspace/runtime.js';
import { WorkspaceComfy, mediaKey } from './workspaceFixture.js';
import { ComfyRequestError } from '../../workflow/comfyAdapter.js';
import { digest } from '../workspace/digest.js';
import type { LibrarySaveIntent } from '../workspace/library.js';
import type { LibrarySaveOperation } from '../workspace/types.js';

class LibraryComfy extends WorkspaceComfy {
  library = new Map<string, { content: unknown; etag: string }>(); reads = 0; offline = false; writes = 0;
  override async getWorkflow(filename: string) {
    this.reads++;
    if (this.offline) throw new ComfyRequestError(503, undefined);
    return structuredClone(this.library.get(filename) ?? null);
  }
  // This represents the browser's conditional write, never a method called by WorkspaceLibrary.
  clientWrite(op: LibrarySaveOperation) {
    const current = this.library.get(op.target.filename);
    if (op.mode === 'create' ? !!current : current?.etag !== op.target.expectedEtag) return false;
    this.writes++; this.library.set(op.target.filename, { content: structuredClone(op.content), etag: digest(op.content) }); return true;
  }
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-library-')); const db = join(directory, 'agent.sqlite');
  const store = new AgentStore(db); const adapter = new LibraryComfy();
  const options = { directory: join(directory, 'media'), serverId: 'test-server', maxPreviews: 4 };
  const runtime = new WorkspaceRuntime(store, adapter, options); const repo = runtime.repository;
  const session = repo.createSession('owner', 'creations');
  const image = () => runtime.workflows.create(session.id, { templateId: 'z-image-turbo', name: 'cat', text: 'cat' }, { requestId: randomUUID() }, adapter.info);
  const intent = (name = 'image'): LibrarySaveIntent => ({ requestId: randomUUID(), revision: 1, mode: 'create', startedBy: 'device-a', target: { serverId: options.serverId, workflowId: randomUUID(), filename: `${name}.json`, name } });
  const close = async () => { await runtime.assets.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); };
  return { directory, db, store, adapter, options, runtime, repo, session, image, intent, close, signal: AbortSignal.timeout(30_000) };
}

test('library intent freezes historical revision, is idempotent, isolates targets and verifies actual file contents', async () => {
  const f = setup();
  try {
    const a = f.image(); const request = f.intent();
    const op = f.runtime.library.begin(f.session.id, a.draft.id, request);
    const edit = f.runtime.workflows.edit(f.session.id, { draftId: a.draft.id, sourceRevision: 1, expectedHeadRevision: 1, summary: 'beach', operations: [{ op: 'set_input', nodeId: '5', input: 'text', value: 'cat on beach' }] }, { requestId: randomUUID() }, f.adapter.info);
    assert.equal(edit.revision.revision, 2);
    assert.equal(f.runtime.library.begin(f.session.id, a.draft.id, request).id, op.id);
    assert.throws(() => f.runtime.library.begin(f.session.id, a.draft.id, { ...request, revision: 2 }), /不同参数/);
    const b = f.image();
    assert.throws(() => f.runtime.library.begin(f.session.id, b.draft.id, f.intent('video')), /待完成/);
    assert.throws(() => f.runtime.library.applying(f.session.id, op.id), /准备/);
    const [prepared, repeated] = await Promise.all([f.runtime.library.prepare(f.session.id, op.id, f.signal), f.runtime.library.prepare(f.session.id, op.id, f.signal)]);
    assert.deepEqual(prepared.content, repeated.content);
    assert.equal(prepared.content!.nodes.find(n => n.id === 5)!.widgets_values![0], 'cat');
    assert.equal(f.adapter.writes, 0); assert.equal(f.adapter.submits, 0);
    const applying = f.runtime.library.applying(f.session.id, op.id);
    assert.equal(f.adapter.clientWrite(applying), true);
    const completed = await f.runtime.library.reconcile(f.session.id, op.id, f.signal);
    assert.equal(completed.state, 'succeeded');
    assert.equal(f.repo.draft(f.session.id, a.draft.id).headRevision, 2);
    assert.equal(f.repo.draft(f.session.id, a.draft.id).lastLibrarySave!.revision, 1);
    assert.equal(f.repo.draft(f.session.id, b.draft.id).lastLibrarySave, undefined);
    assert.equal(f.runtime.library.begin(f.session.id, a.draft.id, request).state, 'succeeded');
    const foreignUpdate = { ...f.intent(), mode: 'update' as const, target: { ...op.target, expectedEtag: completed.result!.etag } };
    assert.throws(() => f.runtime.library.begin(f.session.id, b.draft.id, foreignUpdate), /该草稿/);
    const different = f.runtime.library.begin(f.session.id, b.draft.id, f.intent('video'));
    assert.notEqual(different.target.filename, completed.target.filename);
  } finally { await f.close(); }
});

test('export binds and pins exact media without changing revisions, output prefixes or GPU history', async () => {
  const f = setup();
  try {
    const ref = { filename: 'cat.png', subfolder: '', type: 'input' as const, kind: 'image' as const };
    f.adapter.files.set(mediaKey(ref), await sharp({ create: { width: 16, height: 16, channels: 3, background: 'blue' } }).png().toBuffer());
    const asset = f.runtime.assets.registerUpload(f.session.id, ref, randomUUID());
    const video = f.runtime.workflows.create(f.session.id, { templateId: 'h3-ref-image', name: 'wave', text: 'wave', references: [{ nodeId: '17', inputName: 'image', assetId: asset.id }] }, { requestId: randomUUID() }, f.adapter.info);
    const op = f.runtime.library.begin(f.session.id, video.draft.id, f.intent('wave'));
    const prepared = await f.runtime.library.prepare(f.session.id, op.id, f.signal);
    assert.equal(prepared.inputManifest![0].assetId, asset.id);
    assert.equal(prepared.content!.nodes.find(n => n.id === 17)!.widgets_values![0], prepared.inputManifest![0].materializedRef.filename);
    assert.equal(f.repo.revision(f.session.id, video.draft.id, 1).canvas.nodes.find(n => n.id === 17)!.widgets_values![0], `asset:${asset.id}`);
    assert.equal(Number(f.repo.db.prepare('SELECT COUNT(*) AS n FROM library_asset_refs WHERE asset_id=?').get(asset.id)!.n), 1);
    const normalize = (canvas: typeof video.revision.canvas) => { const copy = structuredClone(canvas); delete copy.extra; copy.nodes.find(n => n.id === 17)!.widgets_values![0] = 'reference'; return copy; };
    assert.deepEqual(normalize(prepared.content!), normalize(video.revision.canvas));
    assert.equal(f.adapter.submits, 0);
    assert.deepEqual((await f.runtime.library.prepare(f.session.id, op.id, f.signal)).content, prepared.content);
  } finally { await f.close(); }
});

test('unknown writes survive restart; unavailable or absent read-back cannot falsely finish the operation', async () => {
  const f = setup(); let restarted: AgentStore | undefined;
  try {
    const a = f.image(); const op = f.runtime.library.begin(f.session.id, a.draft.id, f.intent());
    const prepared = await f.runtime.library.prepare(f.session.id, op.id, f.signal);
    f.runtime.library.applying(f.session.id, op.id);
    assert.equal((await f.runtime.library.reconcile(f.session.id, op.id, f.signal)).state, 'reconciling');
    f.adapter.offline = true;
    await assert.rejects(f.runtime.library.reconcile(f.session.id, op.id, f.signal));
    assert.equal(f.runtime.library.get(f.session.id, op.id).state, 'reconciling');
    assert.throws(() => f.runtime.library.cancel(f.session.id, op.id), /可能已提交/);
    f.adapter.offline = false;
    // Open a second process view of the durable database, with the original conditional export.
    restarted = new AgentStore(f.db); const resumed = new WorkspaceRuntime(restarted, f.adapter, f.options);
    assert.equal(resumed.library.current(f.session.id)!.id, op.id);
    assert.equal(f.adapter.clientWrite(resumed.library.get(f.session.id, op.id)), true);
    assert.equal(f.adapter.clientWrite(prepared), false, 'the same create cannot overwrite itself');
    assert.equal((await resumed.library.reconcile(f.session.id, op.id, f.signal)).state, 'succeeded');
    assert.equal(f.adapter.writes, 1);
    await resumed.assets.stop();
  } finally { restarted?.close(); await f.close(); }
});

test('update preserves remote metadata and original ETag; mismatched content with the correct save marker is conflict', async () => {
  const f = setup();
  try {
    const source = f.image();
    const a = f.repo.createDraft(f.session.id, { name: 'metadata', canvas: { ...source.revision.canvas, extra: { description: 'original description', tags: ['original tag'] } }, outputKinds: ['image'] }, { requestId: randomUUID() });
    const initial = f.runtime.library.begin(f.session.id, a.draft.id, f.intent());
    const prepared = await f.runtime.library.prepare(f.session.id, initial.id, f.signal);
    f.runtime.library.applying(f.session.id, initial.id); f.adapter.clientWrite(prepared);
    const saved = await f.runtime.library.reconcile(f.session.id, initial.id, f.signal);
    f.runtime.workflows.saveCanvas(f.session.id, { draftId: a.draft.id, sourceRevision: 1, expectedHeadRevision: 1, summary: 'different draft display metadata', canvas: { ...a.revision.canvas, extra: { description: 'draft metadata', tags: ['draft tag'] } }, bindings: [] }, { requestId: randomUUID() }, f.adapter.info);
    const updateIntent = { ...f.intent(), revision: 2, mode: 'update' as const, target: { ...initial.target, expectedEtag: saved.result!.etag } };
    const op = f.runtime.library.begin(f.session.id, a.draft.id, updateIntent);
    const update = await f.runtime.library.prepare(f.session.id, op.id, f.signal);
    assert.equal((update.content!.extra as Record<string, unknown>).description, 'original description');
    assert.deepEqual((update.content!.extra as Record<string, unknown>).tags, ['original tag']);
    f.runtime.library.applying(f.session.id, op.id);
    assert.equal((await f.runtime.library.reconcile(f.session.id, op.id, f.signal)).state, 'reconciling', 'unchanged old file may precede a delayed write');
    assert.equal(f.adapter.clientWrite(update), true);
    const tampered = structuredClone(update.content!); tampered.config = { changed: true };
    f.adapter.library.set(op.target.filename, { content: tampered, etag: 'different' });
    assert.equal((await f.runtime.library.reconcile(f.session.id, op.id, f.signal)).state, 'conflict');
    assert.equal(f.repo.draft(f.session.id, a.draft.id).lastLibrarySave!.opId, initial.id);
    assert.equal(f.adapter.clientWrite(update), false);
  } finally { await f.close(); }
});

test('scope, archive, path and server guards reject before IO; pending cancellation releases operation exclusivity', async () => {
  const f = setup();
  try {
    const a = f.image(); const other = f.repo.createSession('other', 'private');
    assert.throws(() => f.runtime.library.begin(f.session.id, a.draft.id, { ...f.intent(), target: { ...f.intent().target, serverId: 'foreign' } }), /服务器/);
    assert.throws(() => f.runtime.library.begin(f.session.id, a.draft.id, { ...f.intent(), target: { ...f.intent().target, filename: '../bad.json' } }), /文件名/);
    const op = f.runtime.library.begin(f.session.id, a.draft.id, f.intent());
    await assert.rejects(f.runtime.library.prepare(other.id, op.id, f.signal), /找不到/);
    assert.equal(f.adapter.reads, 0);
    f.runtime.library.cancel(f.session.id, op.id);
    assert.equal(f.runtime.library.current(f.session.id), null);
    const next = f.runtime.library.begin(f.session.id, a.draft.id, f.intent('next'));
    f.runtime.library.cancel(f.session.id, next.id);
    f.repo.updateDraft(f.session.id, a.draft.id, { archivedAt: Date.now() });
    assert.throws(() => f.runtime.library.begin(f.session.id, a.draft.id, f.intent('archived')), /归档/);
  } finally { await f.close(); }
});
