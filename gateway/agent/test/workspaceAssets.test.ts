import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { AgentStore } from '../store.js';
import type { MediaRef } from '../store.js';
import { ComfyAdapter, ComfyRequestError } from '../../workflow/comfyAdapter.js';
import { AssetService, inspectMedia } from '../workspace/assets.js';
import { locateOutputs } from '../workspace/outputs.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { textToImage } from '../templates.js';
import { canvasToPrompt } from '../../workflow/canvas.js';
import type { Run } from '../workspace/types.js';
import { info } from './fixture.js';

const sourceRef = { filename: 'cat.png', subfolder: 'generated', type: 'output' };
const refKey = (ref: MediaRef) => JSON.stringify([ref.type, ref.subfolder, ref.filename]);
const makeImage = (background = 'red') => sharp({ create: { width: 24, height: 48, channels: 3, background } }).png().toBuffer();
class MediaComfy extends ComfyAdapter {
  files = new Map<string, Uint8Array>();
  reads = 0; uploads = 0;
  constructor() { super({ comfyUrl: 'http://unused.invalid' }); }
  override async getFile(ref: MediaRef, signal?: AbortSignal, max = 20 * 1024 * 1024) {
    signal?.throwIfAborted(); this.reads++;
    const bytes = this.files.get(refKey(ref));
    if (!bytes) throw new ComfyRequestError(404, undefined);
    if (bytes.byteLength > max) throw new ComfyRequestError(413, undefined);
    return { bytes, mediaType: 'application/octet-stream' };
  }
  override async uploadImage(file: { bytes: Uint8Array; mediaType: string }, filename: string, subfolder: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); this.uploads++;
    const ref = { filename: `${this.uploads}-${filename}`, subfolder, type: 'input' as const };
    this.files.set(refKey(ref), file.bytes);
    return ref;
  }
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-assets-'));
  const dbPath = join(directory, 'agent.sqlite');
  const store = new AgentStore(dbPath);
  const repository = new WorkspaceRepository(store);
  const session = store.create('owner', 'test'); repository.initializeSession(session.id);
  const adapter = new MediaComfy();
  const options = { directory: join(directory, 'media'), serverId: 'comfy-original' };
  const assets = new AssetService(repository, adapter, options);
  const graph = textToImage(info, 'v1-5-pruned-emaonly-fp16.safetensors', 'cat');
  const draft = repository.createDraft(session.id, { name: 'image', canvas: graph, outputKinds: ['image'] }, { requestId: randomUUID() }).draft;
  const run: Run = { id: randomUUID(), sessionId: session.id, draftId: draft.id, revision: 1, state: 'succeeded', serverId: options.serverId,
    submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: Date.now() };
  repository.insertRun(run);
  const generated = assets.registerOutputs(session.id, run.id, { '7': { images: [sourceRef] } });
  return { directory, dbPath, store, repository, session, adapter, options, assets, graph, draft, run, assetId: generated.outputAssetIds[0] };
}

test('full output registration preserves batch occurrences past UI caps and reports explicit protocol limits', () => {
  const raw = { '9': { audio: [{ filename: 'music.wav', type: 'output' }] }, '7': { images: Array.from({ length: 32 }, () => ({ filename: 'same.png', type: 'output' })) } };
  const located = locateOutputs(raw);
  assert.equal(located.outputs.length, 33);
  assert.equal(located.incomplete, false);
  const images = located.outputs.filter(item => item.kind === 'image');
  assert.equal(images[31].displayOrdinal, 32);
  assert.equal(new Set(images.map(item => item.locator)).size, 32);
  assert.deepEqual(JSON.parse(images[1].locator), ['7', 'images', 1]);
  assert.equal(locateOutputs(raw, 16).incomplete, true);
  assert.equal(locateOutputs({ '1': { images: [{ filename: '../private.png', type: 'output' }] } }).outputs.length, 0);
});

test('generated image bytes survive restart and missing ComfyUI input/source files are restored from the same blob', async () => {
  const f = setup();
  let store = f.store, assets = f.assets;
  try {
    f.adapter.files.set(refKey(sourceRef), await makeImage());
    const capture = await assets.capture(f.session.id, f.assetId);
    assert.equal(capture.captureState, 'ready');
    assert.equal(capture.metadata.width, 24); assert.equal(capture.metadata.height, 48);
    const signal = new AbortController().signal;
    const [a, b] = await Promise.all([assets.materialize(f.session.id, f.assetId, 'LoadImage', 'first', signal), assets.materialize(f.session.id, f.assetId, 'LoadImage', 'second', signal)]);
    assert.equal(f.adapter.uploads, 1);
    assert.deepEqual(a.materializedRef, b.materializedRef);
    assert.equal(b.bindingId, 'second');
    assert.equal((await assets.materialize(f.session.id, f.assetId, 'LoadImage', 'again', signal)).blobDigest, capture.blobDigest);
    assert.equal(f.adapter.uploads, 1);
    await assets.stop(); store.close();
    f.adapter.files.clear();
    store = new AgentStore(f.dbPath);
    const repository = new WorkspaceRepository(store);
    assets = new AssetService(repository, f.adapter, f.options);
    const restored = await assets.materialize(f.session.id, f.assetId, 'LoadImage', 'restored', signal);
    assert.equal(restored.blobDigest, capture.blobDigest);
    assert.notEqual(restored.materializedRef.filename, a.materializedRef.filename);
    assert.equal(f.adapter.uploads, 2);
    assert.equal(repository.assets(f.session.id).items.length, 1);
    assert.equal(repository.run(f.session.id, f.run.id).state, 'succeeded');
  } finally { await assets.stop(); store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('a changed input file is replaced with a separate verified copy, while old manifests keep their original location', async () => {
  const f = setup();
  try {
    f.adapter.files.set(refKey(sourceRef), await makeImage());
    const signal = new AbortController().signal;
    const original = await f.assets.materialize(f.session.id, f.assetId, 'LoadImage', 'ref', signal);
    const oldFilename = original.materializedRef.filename;
    f.adapter.files.set(refKey(original.materializedRef), await makeImage('blue'));
    const next = await f.assets.materialize(f.session.id, f.assetId, 'LoadImage', 'ref', signal);
    assert.equal(next.blobDigest, original.blobDigest);
    assert.notEqual(next.materializedRef.filename, oldFilename);
    assert.equal(original.materializedRef.filename, oldFilename);
    assert.equal(f.adapter.uploads, 2);
  } finally { await f.assets.stop(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('missing or corrupted durable content cannot be silently replaced by a same-named source', async () => {
  const f = setup();
  try {
    f.adapter.files.set(refKey(sourceRef), await makeImage());
    const asset = await f.assets.capture(f.session.id, f.assetId);
    await writeFile(join(f.options.directory, `${asset.blobDigest}.blob`), 'corrupt');
    f.adapter.files.set(refKey(sourceRef), await makeImage('green'));
    await assert.rejects(f.assets.materialize(f.session.id, f.assetId, 'LoadImage', 'ref', new AbortController().signal), /丢失或内容被替换/);
    assert.equal(f.repository.asset(f.session.id, f.assetId).blobDigest, asset.blobDigest);
    assert.equal(f.repository.asset(f.session.id, f.assetId).captureState, 'missing');
    assert.equal(f.adapter.uploads, 0);
    f.adapter.files.set(refKey(sourceRef), await makeImage());
    assert.equal((await f.assets.capture(f.session.id, f.assetId)).captureState, 'ready');
    assert.equal((await f.assets.read(f.session.id, f.assetId)).asset.blobDigest, asset.blobDigest);
  } finally { await f.assets.stop(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('content and storage failures leave GPU success intact; uploaded file claims are not trusted as dimensions', async () => {
  const f = setup();
  const limited = new AssetService(f.repository, f.adapter, { ...f.options, maxStorageBytes: 1 });
  try {
    f.adapter.files.set(refKey(sourceRef), Buffer.from('<html>not an image</html>'));
    await assert.rejects(f.assets.capture(f.session.id, f.assetId), /文件内容/);
    assert.equal(f.repository.asset(f.session.id, f.assetId).captureState, 'capture_failed');
    f.adapter.files.set(refKey(sourceRef), await makeImage());
    await assert.rejects(limited.capture(f.session.id, f.assetId), /存储空间/);
    assert.equal(f.repository.asset(f.session.id, f.assetId).captureState, 'capture_failed');
    assert.equal(f.repository.run(f.session.id, f.run.id).state, 'succeeded');
    assert.equal((await readdir(f.options.directory)).length, 0);
    const input = { filename: 'uploaded.png', subfolder: '', type: 'input' as const, kind: 'image' as const, width: 999, height: 999 };
    f.adapter.files.set(refKey(input), await makeImage());
    const requestId = randomUUID();
    const registered = f.assets.registerUpload(f.session.id, input, requestId);
    assert.equal(f.assets.registerUpload(f.session.id, { ...input }, requestId).id, registered.id);
    assert.throws(() => f.assets.registerUpload(f.session.id, { ...input, filename: 'other.png' }, requestId), /请求 ID/);
    const captured = await f.assets.capture(f.session.id, registered.id);
    assert.equal(captured.metadata.width, 24);
    assert.equal(captured.metadata.height, 48);
  } finally { await limited.stop(); await f.assets.stop(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('EXIF orientation is applied to dimensions and foreign-session access never reaches media IO', async () => {
  const f = setup();
  try {
    const bytes = await sharp({ create: { width: 24, height: 48, channels: 3, background: 'red' } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const metadata = await inspectMedia(bytes, 'image');
    assert.equal(metadata.width, 48); assert.equal(metadata.height, 24);
    const other = f.store.create('owner', 'another'); f.repository.initializeSession(other.id);
    assert.throws(() => f.assets.capture(other.id, f.assetId), /找不到/);
    await assert.rejects(f.assets.materialize(other.id, f.assetId, 'LoadImage', 'ref', new AbortController().signal), /找不到/);
    assert.equal(f.adapter.reads, 0); assert.equal(f.adapter.uploads, 0);
  } finally { await f.assets.stop(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('legacy source/copy disagreement is reported; neither file is quietly chosen as the original', async () => {
  const f = setup();
  try {
    f.adapter.files.set(refKey(sourceRef), await makeImage());
    const copy = { filename: 'legacy-copy.png', type: 'input', subfolder: '' };
    f.adapter.files.set(refKey(copy), await makeImage('blue'));
    f.repository.putLocation({ id: randomUUID(), assetId: f.assetId, serverId: f.options.serverId, role: 'input', ref: copy });
    await assert.rejects(f.assets.capture(f.session.id, f.assetId), /源文件与副本内容不同/);
    assert.equal(f.repository.asset(f.session.id, f.assetId).blobDigest, undefined);
    assert.equal((await readdir(f.options.directory)).length, 0);
  } finally { await f.assets.stop(); f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('Run submission is an independent durable operation, completing only when the GPU result is known', () => {
  const f = setup();
  try {
    const task = f.store.enqueue(f.session.id, randomUUID(), 'run', 60_000);
    f.store.update({ ...task, state: 'running' });
    const operation = f.repository.plan(f.session.id, task.id, [{ stepKey: 'run', kind: 'submit_preview', targetDraftId: f.draft.id }])[0];
    const identity = { taskId: task.id, operationId: operation.id };
    const created = f.repository.createRun(f.session.id, f.draft.id, 1, f.options.serverId, identity);
    assert.deepEqual(f.repository.createRun(f.session.id, f.draft.id, 1, f.options.serverId, identity), created);
    assert.equal(f.repository.operation(f.session.id, operation.id).state, 'running');
    assert.throws(() => f.repository.updateRun(f.session.id, created.runId, { state: 'submitting' }), /固定工作流/);
    f.repository.updateRun(f.session.id, created.runId, { state: 'awaiting_approval', approvalDigest: 'a'.repeat(64), executionSnapshot: { canvas: f.graph, prompt: canvasToPrompt(f.graph, info), environment: {} } });
    f.repository.updateRun(f.session.id, created.runId, { state: 'submitting' });
    assert.throws(() => f.repository.updateRun(f.session.id, created.runId, { inputManifest: [{ assetId: f.assetId, bindingId: 'forged', blobDigest: 'b'.repeat(64), serverId: 'other', materializedRef: { filename: 'bad.png', subfolder: '', type: 'input' } }] }), /不可改写/);
    f.repository.updateRun(f.session.id, created.runId, { state: 'reconciling' });
    f.repository.updateRun(f.session.id, created.runId, { state: 'queued', promptId: 'confirmed' });
    f.store.update({ ...f.store.task(task.id), state: 'cancelled' });
    assert.ok(f.repository.activeRuns().some(run => run.id === created.runId), 'cancelling the Task does not hide a submitted Run');
    f.repository.updateRun(f.session.id, created.runId, { state: 'succeeded', completed: Date.now() });
    assert.equal(f.repository.operation(f.session.id, operation.id).state, 'completed');
    assert.equal(f.store.task(task.id).state, 'cancelled', 'recording a late result does not resume the task');
    assert.throws(() => f.repository.updateRun(f.session.id, created.runId, { state: 'submitting' }), /不能执行/);
  } finally { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
