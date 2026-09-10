import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import sharp from 'sharp';
import { AgentStore } from '../store.js';
import { createModelWorkflow } from '../modelProfiles.js';
import { canvasToPrompt } from '../../workflow/canvas.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { AssetService } from '../workspace/assets.js';
import { RunService } from '../workspace/runs.js';
import { assetToken, canonicalCanvas, draftDiagnostics } from '../workspace/compiler.js';
import type { AssetBinding } from '../workspace/types.js';
import { WorkspaceComfy as Comfy, mediaKey as key } from './workspaceFixture.js';

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-runs-'));
  const store = new AgentStore(':memory:'); const repo = new WorkspaceRepository(store);
  const session = store.create('owner', 'movie'); repo.initializeSession(session.id);
  const adapter = new Comfy();
  const assets = new AssetService(repo, adapter, { directory, serverId: 'server' });
  const runs = new RunService(repo, assets, { maxPreviews: 3, reconciliationGraceMs: 0 });
  const graph = createModelWorkflow(adapter.info, { profileId: 'z-image-turbo', text: 'cat' });
  const draft = repo.createDraft(session.id, { name: 'image', canvas: graph, outputKinds: ['image'] }, { requestId: randomUUID() }).draft;
  const task = store.enqueue(session.id, randomUUID(), 'create', 60_000); store.update({ ...task, state: 'running' });
  const createRun = (draftId = draft.id, revision = 1) => {
    const op = repo.plan(session.id, task.id, [{ stepKey: randomUUID(), kind: 'submit_preview', targetDraftId: draftId }])[0];
    return repo.createRun(session.id, draftId, revision, 'server', { taskId: task.id, operationId: op.id }).runId;
  };
  adapter.files.set(key({ filename: 'image.png', subfolder: '', type: 'output' }), await sharp({ create: { width: 32, height: 64, channels: 3, background: 'red' } }).png().toBuffer());
  return { directory, store, repo, session, adapter, assets, runs, graph, draft, task, createRun,
    close: async () => { await assets.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('independent image and video runs compile bound asset identities to exact files without changing logical revisions', async () => {
  const f = await setup();
  try {
    const imageRun = f.createRun();
    assert.equal((await f.runs.prepare(f.session.id, imageRun, new AbortController().signal)).state, 'queued');
    f.adapter.complete = true;
    const imageResult = await f.runs.poll(f.session.id, imageRun);
    const imageId = imageResult.outputAssetIds[0];
    await f.assets.capture(f.session.id, imageId);
    const binding: AssetBinding = { id: 'picture', nodeId: '17', inputName: 'image', role: 'reference_image', assetId: imageId };
    const video = canonicalCanvas(createModelWorkflow(f.adapter.info, { profileId: 'h3-ref-image', text: 'cat waves', referenceImage: 'ref_cat.png' }), [binding]);
    const operation = f.repo.plan(f.session.id, f.task.id, [{ stepKey: 'create-video', kind: 'create_workflow' }])[0];
    const b = f.repo.createDraft(f.session.id, { name: 'video', canvas: video, outputKinds: ['video', 'audio'], bindings: [binding] }, { taskId: f.task.id, operationId: operation.id });
    const videoRun = f.createRun(b.draft.id);
    const submitted = await f.runs.prepare(f.session.id, videoRun, new AbortController().signal);
    assert.equal(submitted.state, 'queued', JSON.stringify(submitted.diagnostic));
    assert.equal(f.adapter.submits, 2);
    assert.equal(submitted.inputManifest[0].assetId, imageId);
    assert.equal(submitted.inputManifest[0].blobDigest, f.repo.asset(f.session.id, imageId).blobDigest);
    assert.equal(submitted.executionSnapshot!.prompt['17'].inputs.image, submitted.inputManifest[0].materializedRef.filename);
    assert.deepEqual(canvasToPrompt(submitted.executionSnapshot!.canvas, f.adapter.info), submitted.executionSnapshot!.prompt);
    assert.equal(canvasToPrompt(f.repo.revision(f.session.id, b.draft.id).canvas, f.adapter.info, false)['17'].inputs.image, assetToken(imageId));
    assert.deepEqual(f.repo.revision(f.session.id, f.draft.id).canvas, f.graph);
    assert.equal((await f.runs.poll(f.session.id, videoRun)).state, 'succeeded');
    assert.equal(f.repo.drafts(f.session.id).items.length, 2);
  } finally { await f.close(); }
});

test('persisted confirmation and concurrent resume submit precisely one fixed Run', async () => {
  const f = await setup();
  try {
    f.repo.updateSession(f.session.id, { previewPolicy: 'confirm' });
    const id = f.createRun();
    const pending = await f.runs.prepare(f.session.id, id, new AbortController().signal);
    assert.equal(pending.state, 'awaiting_approval'); assert.equal(f.adapter.submits, 0);
    f.store.update({ ...f.store.task(f.task.id), state: 'waiting_user' });
    f.runs.approve(f.session.id, id, pending.approvalDigest!, true);
    assert.throws(() => f.runs.approve(f.session.id, id, pending.approvalDigest!, true), /已经回答/);
    f.store.update({ ...f.store.task(f.task.id), state: 'running' });
    const restarted = new RunService(f.repo, f.assets, { maxPreviews: 3 });
    await Promise.all([restarted.submit(f.session.id, id, new AbortController().signal), restarted.submit(f.session.id, id, new AbortController().signal)]);
    assert.equal(f.adapter.submits, 1);
    assert.equal(f.store.task(f.task.id).previews, 1);
    assert.equal(f.repo.run(f.session.id, id).approvalDigest, pending.approvalDigest);
  } finally { await f.close(); }
});

test('lost submissions reconcile after cancellation and retain late results without restarting the task', async () => {
  const f = await setup();
  try {
    f.adapter.mode = 'lost';
    const id = f.createRun();
    assert.equal((await f.runs.prepare(f.session.id, id, new AbortController().signal)).state, 'reconciling');
    f.store.update({ ...f.store.task(f.task.id), state: 'cancelled' });
    const restarted = new RunService(f.repo, f.assets, { maxPreviews: 3 });
    await restarted.pollActive();
    assert.equal(f.repo.run(f.session.id, id).state, 'queued');
    f.adapter.complete = true;
    await restarted.pollActive();
    assert.equal(f.repo.run(f.session.id, id).state, 'succeeded');
    assert.equal(f.repo.run(f.session.id, id).outputAssetIds.length, 1);
    assert.equal(f.store.task(f.task.id).state, 'cancelled');
    assert.equal(f.adapter.submits, 1);
  } finally { await f.close(); }
});

test('unknown submissions and a server change are never retried on the current connection', async () => {
  const f = await setup();
  let other: AssetService | undefined;
  try {
    f.adapter.mode = 'unknown';
    const id = f.createRun();
    await f.runs.prepare(f.session.id, id, new AbortController().signal);
    assert.equal((await f.runs.poll(f.session.id, id)).state, 'unknown');
    await f.runs.submit(f.session.id, id, new AbortController().signal);
    assert.equal(f.adapter.submits, 1);
    f.adapter.mode = 'ok';
    const second = f.createRun();
    await f.runs.prepare(f.session.id, second, new AbortController().signal);
    other = new AssetService(f.repo, f.adapter, { directory: f.directory, serverId: 'different-server' });
    const wrongServer = new RunService(f.repo, other, { maxPreviews: 3 });
    assert.equal((await wrongServer.poll(f.session.id, second)).state, 'unknown');
    assert.equal(f.adapter.submits, 2);
  } finally { await other?.stop(); await f.close(); }
});

test('unbound media stays editable but cannot execute or bypass installed-model validation', async () => {
  const f = await setup();
  try {
    const graph = createModelWorkflow(f.adapter.info, { profileId: 'h3-ref-image', text: 'wave', referenceImage: 'ref_cat.png' });
    assert.ok(draftDiagnostics(graph, [], f.adapter.info).some(d => d.code === 'unbound_asset'));
    const operation = f.repo.plan(f.session.id, f.task.id, [{ stepKey: 'unbound', kind: 'create_workflow' }])[0];
    const b = f.repo.createDraft(f.session.id, { name: 'unbound', canvas: graph, outputKinds: ['video'] }, { taskId: f.task.id, operationId: operation.id });
    const id = f.createRun(b.draft.id);
    assert.equal((await f.runs.prepare(f.session.id, id, new AbortController().signal)).state, 'failed');
    assert.equal(f.adapter.submits, 0);
    const missing = structuredClone(f.adapter.info);
    missing.UnetLoaderGGUF.input!.required!.unet_name[0] = [];
    assert.ok(draftDiagnostics(graph, [], missing).some(d => d.code === 'invalid_choice'));
  } finally { await f.close(); }
});
