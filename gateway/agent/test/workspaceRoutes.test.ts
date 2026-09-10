import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as openRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { MockLanguageModelV3 } from 'ai/test';
import { AgentService } from '../service.js';
import { handleAgentRequest } from '../routes.js';
import { WorkspaceComfy, mediaKey } from './workspaceFixture.js';
import type { Asset, Run } from '../workspace/types.js';
import { migrateLegacyWorkspace } from '../workspace/migration.js';
import { createModelWorkflow } from '../modelProfiles.js';

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-http-'));
  const adapter = new WorkspaceComfy();
  const service = new AgentService({ agentStorePath: join(directory, 'agent.sqlite'), comfyUrl: 'http://unused.invalid', agentWorkspace: { directory: join(directory, 'assets'), serverId: 'server' } }, { adapter, model: new MockLanguageModelV3() });
  // Owner injection belongs only to this isolated harness; the real gateway supplies its authenticated workspace owner.
  const server = createServer((request, response) => { void handleAgentRequest(service, String(request.headers['x-test-owner'] ?? 'owner'), request, response, new URL(request.url!, 'http://localhost')); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/gateway/agent`;
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-agent-schema-version': '2', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, adapter, service, server, base, request, close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await service.stop(); rmSync(directory, { recursive: true, force: true }); } };
}

test('permanent cleanup requires an owned archived session and reviewed confirmation, then rejects chat access and late writes', async () => {
  const f = await setup();
  try {
    const session = (await f.request('/sessions', 'POST', { name: 'Purge fixture' })).body.session;
    const path = `/sessions/${session.id}`;
    const draft = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'Unused image', template: { templateId: 'z-image-turbo', text: 'cat' } })).body;
    const unarchived = await f.request(`${path}/cleanup`);
    assert.ok(unarchived.body.plan.blockers.length);
    assert.equal((await f.request(`${path}/cleanup`, 'GET', undefined, { 'x-test-owner': 'other' })).status, 404);
    assert.equal((await f.request(`${path}/cleanup`, 'GET', undefined, { 'x-agent-server-id': 'different-server' })).status, 409);
    await f.request(path, 'PATCH', { archivedAt: Date.now() });
    const { plan } = (await f.request(`${path}/cleanup`)).body;
    assert.equal(plan.total.drafts, 1); assert.equal(plan.retained.drafts, 0);
    const body = { requestId: randomUUID(), planToken: plan.token, confirm: 'delete-chat' };
    assert.equal((await f.request(`${path}/cleanup`, 'POST', { ...body, confirm: false })).status, 400);
    assert.equal((await f.request(`${path}/cleanup`, 'POST', body, { 'x-agent-schema-version': '1' })).status, 426);
    assert.equal((await f.request(`${path}/cleanup`, 'POST', { ...body, planToken: '0'.repeat(64) })).status, 409);
    assert.equal((await f.request(path)).status, 200);
    // The upload passed the route's first session check, but its body has not finished arriving.
    const arrived = new Promise<void>(resolve => f.server.once('request', () => resolve()));
    const payload = JSON.stringify({ requestId: randomUUID(), file: { filename: 'late.png', subfolder: '', type: 'input', kind: 'image' } });
    const slow = openRequest(`${f.base}${path}/assets`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-agent-schema-version': '2' } });
    slow.setTimeout(5000, () => slow.destroy(new Error('slow upload test timed out')));
    const slowResponse = new Promise<number | undefined>((resolve, reject) => { slow.on('response', response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }); slow.on('error', reject); });
    slow.write(payload.slice(0, 12)); await arrived;
    const result = await f.request(`${path}/cleanup`, 'POST', body);
    slow.end(payload.slice(12));
    assert.equal(await slowResponse, 410, 'a request whose body finishes after cleanup cannot register a new asset');
    assert.equal(result.status, 200); assert.equal(result.body.operation.state, 'completed');
    assert.equal((await f.request(path)).status, 410);
    assert.equal((await f.request(path, 'PATCH', { archivedAt: null })).status, 410);
    assert.equal((await f.request(`${path}/messages`, 'POST', { requestId: randomUUID(), message: 'late message' })).status, 410);
    assert.equal((await f.request(`${path}/drafts/${draft.draft.id}/versions`, 'POST', { requestId: randomUUID(), expectedHeadRevision: 1, sourceRevision: 1, canvas: draft.revision.canvas, bindings: [], summary: 'late save' })).status, 410);
    assert.equal((await f.request('/sessions?archived=true')).body.items.some((item: { id: string }) => item.id === session.id), false);
    assert.deepEqual((await f.request(`${path}/cleanup`, 'POST', body)).body, result.body);
    assert.equal((await f.request(`${path}/cleanup`, 'POST', { ...body, requestId: randomUUID() })).status, 409);
    assert.equal(f.adapter.submits, 0);
    assert.equal(f.service.workspace!.repository.assets(session.id).items.length, 0);
    assert.deepEqual(f.service.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { await f.close(); }
});

test('migrated transcript and old read-only version URLs resolve exact objects without changing original events', async () => {
  const f = await setup();
  try {
    const canvas = createModelWorkflow(f.adapter.info, { profileId: 'z-image-turbo', text: 'old image' });
    const session = f.service.store.create('owner', 'Mixed old chat', canvas);
    const upload = { filename: 'same.png', subfolder: '', type: 'input' as const, kind: 'image' as const };
    const task = f.service.store.enqueue(session.id, randomUUID(), 'old user', 60_000, [upload, upload]);
    f.service.store.update({ ...task, state: 'completed' });
    f.service.store.event(session.id, task.id, 'workflow', { version: 1, summary: 'old image' });
    f.service.store.event(session.id, task.id, 'state', { state: 'waiting_comfy', version: 1, promptId: 'old-prompt' });
    const outputs = Array.from({ length: 12 }, (_, index) => ({ filename: index ? 'same.png' : 'sound.wav', subfolder: '', type: 'output', kind: index ? 'image' : 'audio' }));
    f.service.store.event(session.id, task.id, 'result', { version: 1, promptId: 'old-prompt', success: true, outputs });
    f.service.store.event(session.id, task.id, 'result', { version: 99, promptId: 'missing-origin', success: true, outputs: [outputs[1]] });
    f.service.store.commitVersion(session.id, 1, createModelWorkflow(f.adapter.info, { profileId: 'z-image-turbo', text: 'new head' }), 'changed');
    const original = f.service.store.db.prepare('SELECT * FROM events WHERE session_id=? ORDER BY seq').all(session.id);
    migrateLegacyWorkspace(f.service.workspace!.repository, 'server');
    const endpoint = `/sessions/${session.id}`;
    const snapshot = await f.request(endpoint); assert.equal(snapshot.status, 200);
    const events = snapshot.body.events as { seq: number; kind: string; data: { version?: number; workspaceLegacy?: { reference?: { draftId: string; revision: number }; run?: Run; outputs: { index: number; assetId: string }[]; attachments: { index: number; assetId: string }[]; incomplete: boolean } } }[];
    const result = events.find(event => event.kind === 'result' && event.data.version === 1)!;
    const mapped = result.data.workspaceLegacy!;
    assert.equal(mapped.reference!.revision, 1); assert.equal(mapped.run!.legacy!.incomplete, true);
    assert.deepEqual(mapped.outputs.map(output => output.index), Array.from({ length: 12 }, (_, i) => i));
    assert.equal(new Set(mapped.outputs.map(output => output.assetId)).size, 12);
    assert.equal(events.find(event => event.kind === 'state' && event.data.workspaceLegacy)?.data.workspaceLegacy!.run!.id, mapped.run!.id);
    assert.equal(events.find(event => event.kind === 'workflow')!.data.workspaceLegacy!.reference!.draftId, mapped.reference!.draftId);
    const attachments = events.find(event => event.kind === 'user')!.data.workspaceLegacy!.attachments;
    assert.equal(attachments.length, 2); assert.notEqual(attachments[0].assetId, attachments[1].assetId);
    const incomplete = events.find(event => event.data.version === 99)!.data.workspaceLegacy!;
    assert.equal(incomplete.incomplete, true); assert.equal(incomplete.reference, undefined); assert.equal(incomplete.run, undefined); assert.deepEqual(incomplete.outputs, []);
    const old = await f.request(`${endpoint}/versions/1`);
    assert.equal(old.status, 200); assert.equal(old.body.readOnly, true); assert.equal(old.body.reference.revision, 1); assert.deepEqual(old.body.revision.canvas, canvas);
    assert.equal((await f.request(`${endpoint}/versions/99`)).status, 404);
    assert.equal((await f.request(`${endpoint}/versions/1`, 'GET', undefined, { 'x-test-owner': 'other' })).status, 404);
    assert.equal((await f.request(`${endpoint}/versions/1`, 'POST', { canvas })).status, 426);
    assert.deepEqual(f.service.store.db.prepare('SELECT * FROM events WHERE session_id=? AND seq<=? ORDER BY seq').all(session.id, Number(original.at(-1)!.seq)), original);
    assert.equal((await f.request(`${endpoint}/drafts/${mapped.reference!.draftId}`)).body.draft.headRevision, 2);
    assert.equal(f.adapter.submits, 0);
  } finally { await f.close(); }
});

test('HTTP explicit generation fixes its revision, enforces scope and returns the same run after completion', async () => {
  const f = await setup(); f.adapter.complete = true;
  try {
    const session = (await f.request('/sessions', 'POST', { name: 'Canvas generation' })).body.session;
    const path = `/sessions/${session.id}`;
    const created = await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'Image', template: { templateId: 'z-image-turbo', text: 'cat', seed: 42 } });
    const body = { requestId: randomUUID(), draftId: created.body.draft.id, revision: 1 };
    assert.equal((await f.request(`${path}/runs`, 'POST', body, { 'x-agent-schema-version': '1' })).status, 426);
    assert.equal((await f.request(`${path}/runs`, 'POST', body, { 'x-test-owner': 'foreign' })).status, 404);
    assert.equal((await f.request(`${path}/runs`, 'POST', { ...body, revision: 99 })).status, 404);
    const accepted = await f.request(`${path}/runs`, 'POST', body);
    assert.equal(accepted.status, 202); assert.ok(accepted.body.runId); assert.ok(accepted.body.taskId);
    assert.deepEqual((await f.request(`${path}/runs`, 'POST', body)).body, accepted.body);
    for (let i = 0; i < 5; i++) await f.service.tick();
    const replay = await f.request(`${path}/runs`, 'POST', body);
    assert.equal(replay.status, 202); assert.equal(replay.body.runId, accepted.body.runId); assert.equal(replay.body.state, 'completed');
    assert.equal(f.adapter.submits, 1);
    assert.equal((await f.request(`${path}/drafts/${body.draftId}`)).body.draft.headRevision, 1);
    assert.equal((await f.request(`${path}/runs`)).body.items.length, 1);
  } finally { await f.close(); }
});

test('the canvas server identity header rejects reads and writes on a replacement backend', async () => {
  const f = await setup();
  try {
    const session = (await f.request('/sessions', 'POST', { name: 'identity' })).body.session;
    const path = `/sessions/${session.id}`;
    const body = { source: 'template', requestId: randomUUID(), name: 'Image', template: { templateId: 'z-image-turbo', text: 'cat' } };
    const wrong = { 'x-agent-server-id': encodeURIComponent('other-server') };
    assert.equal((await f.request(path, 'GET', undefined, wrong)).status, 409);
    assert.equal((await f.request(`${path}/drafts`, 'POST', body, wrong)).status, 409);
    assert.equal((await f.request(`${path}/drafts`)).body.items.length, 0);
    const created = await f.request(`${path}/drafts`, 'POST', body, { 'x-agent-server-id': 'server' });
    assert.equal(created.status, 201);
    assert.equal((await f.request(`${path}/drafts/${created.body.draft.id}`, 'PATCH', { archivedAt: Date.now() }, wrong)).status, 409);
    assert.equal((await f.request(`${path}/drafts/${created.body.draft.id}`)).body.draft.archivedAt, undefined);
    assert.equal((await f.request(`${path}/runs`)).body.items.length, 0);
  } finally { await f.close(); }
});

test('workspace HTTP writes require v2 identities, preserve independent histories, and enforce owner scope', async () => {
  const f = await setup();
  try {
    const status = await f.request('/status'); assert.equal(status.body.agentSchemaVersion, 2);
    assert.equal((await f.request('/sessions', 'POST', { name: 'legacy' }, { 'x-agent-schema-version': '' })).status, 426);
    const { body: { session } } = await f.request('/sessions', 'POST', { name: 'movie' });
    const path = `/sessions/${session.id}`;
    const body = { source: 'template', requestId: randomUUID(), name: 'cat', template: { templateId: 'z-image-turbo', text: 'cat' } };
    const created = await f.request(`${path}/drafts`, 'POST', body); assert.equal(created.status, 201);
    const again = await f.request(`${path}/drafts`, 'POST', body); assert.equal(again.body.draft.id, created.body.draft.id);
    assert.equal((await f.request(`${path}/drafts`, 'POST', { ...body, name: 'other' })).status, 409);
    const draftId = created.body.draft.id;
    assert.equal((await f.request(`${path}/drafts/${draftId}`, 'GET', undefined, { 'x-test-owner': 'foreign' })).status, 404);
    assert.equal((await f.request(`${path}/versions`, 'POST', { canvas: created.body.revision.canvas, baseVersion: 1 })).status, 426);
    const fork = await f.request(`${path}/drafts/${draftId}/fork`, 'POST', { requestId: randomUUID(), sourceRevision: 1, name: 'alternative' });
    assert.equal(fork.status, 201); assert.equal(fork.body.draft.forkedFrom.draftId, draftId);
    const one = await f.request(`${path}/drafts?limit=1`); assert.equal(one.body.items.length, 1); assert.ok(one.body.nextCursor);
    const two = await f.request(`${path}/drafts?limit=1&before=${one.body.nextCursor}`); assert.equal(two.body.items[0].id, draftId);
    assert.equal((await f.request(`${path}/drafts/${draftId}`, 'PATCH', { headRevision: 10 })).status, 400);
    const edit = { requestId: randomUUID(), canvas: created.body.revision.canvas, bindings: [], sourceRevision: 1, expectedHeadRevision: 1, summary: 'canvas layout' };
    const saved = await f.request(`${path}/drafts/${draftId}/versions`, 'POST', edit); assert.equal(saved.status, 201); assert.equal(saved.body.revision.revision, 2);
    assert.equal((await f.request(`${path}/drafts/${draftId}/versions`, 'POST', { ...edit, requestId: randomUUID() })).status, 409);
    const task = await f.request(`${path}/messages`, 'POST', { requestId: randomUUID(), message: 'edit', context: { targetDraftId: draftId, sourceRevision: 1 } }); assert.equal(task.status, 202);
    assert.equal((await f.request(`${path}/drafts/${draftId}`, 'PATCH', { name: 'race' })).status, 409);
    assert.equal((await f.request(`${path}/cancel`, 'POST', { taskId: task.body.taskId })).status, 200);
    const snapshot = await f.request(path); assert.equal(snapshot.body.drafts.items.length, 2);
    assert.ok(snapshot.body.highWater >= snapshot.body.cursor); assert.equal(snapshot.body.tasks[0].messages, undefined);
    assert.equal(snapshot.body.session.version, undefined);
  } finally { await f.close(); }
});

test('workspace media remains authenticated, content-verified and seekable; event cursor has a fixed high-water boundary', async () => {
  const f = await setup();
  try {
    const { body: { session } } = await f.request('/sessions', 'POST', { name: 'media' });
    const path = `/sessions/${session.id}`;
    const bytes = await sharp({ create: { width: 24, height: 48, channels: 3, background: 'green' } }).png().toBuffer();
    const ref = { filename: 'uploaded.png', subfolder: '', type: 'input' as const };
    f.adapter.files.set(mediaKey(ref), bytes);
    const upload = { requestId: randomUUID(), file: { ...ref, kind: 'image', width: 999, height: 999 } };
    const registered = await f.request(`${path}/assets`, 'POST', upload); assert.equal(registered.status, 201);
    const assetId = registered.body.asset.id;
    assert.equal((await f.request(`${path}/assets`, 'POST', upload)).body.asset.id, assetId);
    assert.equal((await f.request(`${path}/assets`, 'POST', { requestId: randomUUID(), file: { ...ref, kind: 'image', filename: '../secret' } })).status, 422);
    const unauthorized = await fetch(`${f.base}${path}/assets/${assetId}/content`, { headers: { 'x-test-owner': 'foreign' } }); assert.equal(unauthorized.status, 404);
    const response = await fetch(`${f.base}${path}/assets/${assetId}/content`); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const preview = await fetch(`${f.base}/assets/${assetId}/content`);
    assert.equal(preview.status, 200); assert.deepEqual(Buffer.from(await preview.arrayBuffer()), bytes);
    assert.equal((await fetch(`${f.base}/assets/${assetId}/content`, { headers: { 'x-test-owner': 'foreign' } })).status, 404);
    assert.equal((await f.request(`/assets/${randomUUID()}/content`)).status, 404);
    assert.equal((await f.request(`/assets/${assetId}/content`, 'POST', {})).status, 404);
    const range = await fetch(`${f.base}${path}/assets/${assetId}/content`, { headers: { range: 'bytes=0-7' } }); assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8)); assert.equal(range.headers.get('content-range'), `bytes 0-7/${bytes.length}`);
    const invalid = await fetch(`${f.base}${path}/assets/${assetId}/content`, { headers: { range: `bytes=${bytes.length}-` } }); assert.equal(invalid.status, 416);
    const unchanged = await fetch(`${f.base}${path}/assets/${assetId}/content`, { headers: { 'if-none-match': response.headers.get('etag')! } }); assert.equal(unchanged.status, 304);
    const asset = (await f.request(`${path}/assets/${assetId}`)).body.asset; assert.equal(asset.metadata.width, 24); assert.equal(asset.metadata.height, 48);
    for (let i = 0; i < 210; i++) f.service.store.event(session.id, null, 'notice', { i });
    const snapshot = (await f.request(path)).body; assert.equal(snapshot.events.length, 200); assert.equal(snapshot.hasMore, true);
    assert.ok(snapshot.events.every((event: { seq: number }) => event.seq <= snapshot.highWater));
    const next = (await f.request(`${path}?after=${snapshot.cursor}`)).body;
    assert.equal(next.hasMore, false); assert.equal(next.cursor, next.highWater);
    assert.ok(next.events.every((event: { seq: number }) => event.seq > snapshot.cursor));
  } finally { await f.close(); }
});

test('workspace session search and archive restoration work across pages without leaking other owners', async () => {
  const f = await setup();
  try {
    const first = (await f.request('/sessions', 'POST', { name: 'cat image' })).body.session;
    const second = (await f.request('/sessions', 'POST', { name: 'cat video' })).body.session;
    await f.request('/sessions', 'POST', { name: 'cat foreign' }, { 'x-test-owner': 'foreign' });
    const one = (await f.request('/sessions?limit=1&search=CAT')).body;
    assert.equal(one.items[0].id, second.id); assert.ok(one.nextCursor);
    const two = (await f.request(`/sessions?limit=1&search=cat&before=${one.nextCursor}`)).body;
    assert.equal(two.items[0].id, first.id); assert.equal(two.nextCursor, undefined);
    f.service.store.event(first.id, null, 'user', { text: 'blue ocean' });
    f.service.store.event(first.id, null, 'user', { text: 'latest instruction' });
    const found = (await f.request('/sessions?search=ocean')).body.items[0];
    assert.equal(found.id, first.id); assert.equal(found.preview, 'blue ocean'); assert.equal(found.lastMessage, 'latest instruction');
    assert.equal((await f.request(`/sessions/${first.id}`, 'PATCH', { archivedAt: Date.now() })).status, 200);
    assert.deepEqual((await f.request('/sessions')).body.items.map((item: { id: string }) => item.id), [second.id]);
    assert.equal((await f.request('/sessions?archived=true')).body.items[0].id, first.id);
    assert.equal((await f.request(`/sessions/${first.id}`, 'PATCH', { archivedAt: null })).status, 200);
    assert.equal((await f.request('/sessions?archived=true')).body.items.length, 0);
    assert.equal((await f.request('/sessions')).body.items.length, 2);
  } finally { await f.close(); }
});

test('draft rename, archive and restore retain history and dependent video bindings without generating', async () => {
  const f = await setup();
  try {
    const session = (await f.request('/sessions', 'POST', { name: 'manage creations' })).body.session;
    const path = `/sessions/${session.id}`;
    const created = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'image', template: { templateId: 'z-image-turbo', text: 'cat' } })).body;
    const draftPath = `${path}/drafts/${created.draft.id}`;
    const repo = f.service.workspace!.repository;
    const run: Run = { id: randomUUID(), sessionId: session.id, draftId: created.draft.id, revision: 1, serverId: 'server', state: 'succeeded', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: Date.now() };
    repo.insertRun(run);
    const asset: Asset = { id: randomUUID(), sessionId: session.id, name: 'image.png', origin: 'generated', kind: 'image', displayOrdinal: 1, sourceRunId: run.id, outputLocator: '99:images:0', captureState: 'remote_only', metadata: {}, created: Date.now() };
    repo.registerAsset(asset); repo.updateRun(session.id, run.id, { outputAssetIds: [asset.id] });
    const video = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'video', template: { templateId: 'h3-ref-image', text: 'cat waves', references: [{ nodeId: '17', inputName: 'image', assetId: asset.id }] } })).body;
    const beforeVideo = (await f.request(`${path}/drafts/${video.draft.id}/versions/1`)).body;
    assert.equal((await f.request(draftPath, 'PATCH', { name: '  seaside cat  ' })).body.draft.name, 'seaside cat');
    assert.equal((await f.request(draftPath, 'PATCH', { name: ' ' })).status, 400);
    assert.equal((await f.request(draftPath, 'PATCH', { archivedAt: Date.now() }, { 'x-test-owner': 'foreign' })).status, 404);
    assert.equal((await f.request(draftPath, 'PATCH', { archivedAt: Date.now() })).status, 200);
    assert.deepEqual((await f.request(`${path}/drafts`)).body.items.map((draft: { id: string }) => draft.id), [video.draft.id]);
    const page = (await f.request(`${path}/drafts?archived=true&limit=1`)).body;
    assert.equal((await f.request(`${path}/drafts?archived=true&limit=1&before=${page.nextCursor}`)).body.items[0].id, created.draft.id);
    assert.deepEqual((await f.request(`${draftPath}/versions/1`)).body, created.revision);
    assert.equal((await f.request(`${path}/assets/${asset.id}`)).body.sourceRun.draftId, created.draft.id);
    assert.equal((await f.request(`${path}/assets/${asset.id}/uses`)).body.items[0].draftId, video.draft.id);
    assert.deepEqual((await f.request(`${path}/drafts/${video.draft.id}/versions/1`)).body, beforeVideo);
    assert.equal((await f.request(`${path}/runs`, 'POST', { requestId: randomUUID(), draftId: created.draft.id, revision: 1 })).status, 409);
    assert.equal((await f.request(`${draftPath}/restore`, 'POST', { requestId: randomUUID(), sourceRevision: 1, expectedHeadRevision: 1 })).status, 409);
    assert.equal((await f.request(draftPath, 'PATCH', { archivedAt: null })).status, 200);
    assert.equal((await f.request(`${path}/drafts`)).body.items.length, 2);
    const restored = (await f.request(draftPath)).body.draft;
    assert.equal(restored.name, 'seaside cat'); assert.equal(restored.headRevision, 1); assert.equal(restored.archivedAt, undefined);
    assert.equal((await f.request(`${draftPath}/versions`)).body.items.length, 1);
    assert.equal((await f.request(`${path}/runs`)).body.items.length, 1); assert.equal(f.adapter.submits, 0);
  } finally { await f.close(); }
});

test('HTTP run cards have per-draft generation counts and stable ascending output pagination beyond 16 items', async () => {
  const f = await setup();
  try {
    const session = (await f.request('/sessions', 'POST', { name: 'batch' })).body.session;
    const path = `/sessions/${session.id}`;
    const created = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'images', template: { templateId: 'z-image-turbo', text: 'cat' } })).body;
    const repo = f.service.workspace!.repository;
    const run: Run = { id: randomUUID(), sessionId: session.id, draftId: created.draft.id, revision: 1, serverId: 'server', state: 'succeeded', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: Date.now() };
    repo.insertRun(run);
    for (let index = 1; index <= 32; index++) {
      const asset: Asset = { id: randomUUID(), sessionId: session.id, name: `image-${index}.png`, origin: 'generated', kind: 'image', displayOrdinal: index, sourceRunId: run.id, outputLocator: `99:images:${index}`, captureState: 'remote_only', metadata: {}, created: Date.now() };
      repo.registerAsset(asset); run.outputAssetIds.push(asset.id);
    }
    repo.updateRun(session.id, run.id, { outputAssetIds: run.outputAssetIds });
    const second: Run = { ...run, id: randomUUID(), submissionKey: randomUUID(), generation: undefined, outputAssetIds: [] }; repo.insertRun(second);
    const runs = (await f.request(`${path}/runs`)).body.items;
    assert.deepEqual(runs.map((value: Run) => value.generation), [2, 1]);
    assert.equal(runs[1].outputAssetIds.length, 16); assert.equal(runs[1].outputCount, 32);
    assert.equal((await f.request(`${path}/drafts/${created.draft.id}`)).body.draft.latestRun.id, second.id);
    const firstPage = (await f.request(`${path}/runs/${run.id}/assets?limit=20`)).body;
    const secondPage = (await f.request(`${path}/runs/${run.id}/assets?limit=20&after=${firstPage.nextCursor}`)).body;
    assert.deepEqual([...firstPage.items, ...secondPage.items].map((asset: Asset) => asset.displayOrdinal), Array.from({ length: 32 }, (_, i) => i + 1));
    assert.equal(secondPage.nextCursor, undefined);
    assert.equal((await f.request(`${path}/runs/${run.id}`)).body.run.outputAssetIds.length, 32);
    assert.equal((await f.request(`${path}/runs/${run.id}/assets`, 'GET', undefined, { 'x-test-owner': 'foreign' })).status, 404);
    const sourceRef = { serverId: 'server', workflowId: 'library-image', filename: 'cat.json', name: 'cat', etag: 'etag' };
    const imported = (await f.request(`${path}/drafts`, 'POST', { source: 'canvas', name: 'imported', requestId: randomUUID(), canvas: created.revision.canvas, bindings: [], sourceRef })).body;
    assert.deepEqual(imported.draft.sourceRef, sourceRef);
    const usesAsset = run.outputAssetIds[0];
    const video = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'video', template: { templateId: 'h3-ref-image', text: 'cat waves', references: [{ nodeId: '17', inputName: 'image', assetId: usesAsset }] } })).body;
    const uses = (await f.request(`${path}/assets/${usesAsset}/uses`)).body.items;
    assert.equal(uses.length, 1); assert.equal(uses[0].draftId, video.draft.id); assert.equal(uses[0].revision, 1);
  } finally { await f.close(); }
});

test('library HTTP exposes fixed content, rejects claimed success and recovers verified client writes', async () => {
  const f = await setup(); const files = new Map<string, { content: unknown; etag: string }>();
  f.adapter.getWorkflow = async filename => files.get(filename) ?? null;
  try {
    const session = (await f.request('/sessions', 'POST', { name: 'Library' })).body.session;
    const path = `/sessions/${session.id}`;
    const created = await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'Image', template: { templateId: 'z-image-turbo', text: 'cat' } });
    const intent = { requestId: randomUUID(), revision: 1, mode: 'create', startedBy: 'test', target: { serverId: 'server', workflowId: randomUUID(), filename: 'image.json', name: 'image' } };
    const startPath = `${path}/drafts/${created.body.draft.id}/library-saves`;
    assert.equal((await f.request(startPath, 'POST', intent, { 'x-agent-schema-version': '1' })).status, 426);
    assert.equal((await f.request(startPath, 'POST', intent, { 'x-test-owner': 'foreign' })).status, 404);
    const started = await f.request(startPath, 'POST', intent); assert.equal(started.status, 201);
    const opPath = `${path}/library-saves/${started.body.operation.id}`;
    assert.equal((await f.request(`${path}/library-saves`)).body.operation.id, intent.requestId);
    assert.equal((await f.request(`${opPath}/applying`, 'POST', {})).status, 409);
    const prepared = await f.request(`${opPath}/prepare`, 'POST', {}); assert.equal(prepared.status, 200); assert.ok(prepared.body.operation.contentDigest);
    assert.equal((await f.request(`${path}/library-saves`)).body.operation.content, undefined);
    assert.equal((await f.request(opPath, 'PATCH', { state: 'succeeded', result: { etag: 'claimed' } })).status, 404);
    assert.equal((await f.request(`${opPath}/reconcile`, 'POST', { state: 'succeeded' })).status, 400);
    assert.equal((await f.request(`${opPath}/applying`, 'POST', {})).status, 200);
    assert.equal((await f.request(`${opPath}/reconcile`, 'POST', {})).body.operation.state, 'reconciling');
    files.set(intent.target.filename, { content: prepared.body.operation.content, etag: 'verified-file-etag' });
    const completed = await f.request(`${opPath}/reconcile`, 'POST', {});
    assert.equal(completed.body.operation.state, 'succeeded'); assert.equal(completed.body.operation.result.etag, 'verified-file-etag');
    assert.equal((await f.request(`${path}/library-saves`)).body.operation, null);
    assert.equal((await f.request(`${path}/drafts/${created.body.draft.id}`)).body.draft.lastLibrarySave.revision, 1);
    assert.equal((await f.request(opPath, 'GET', undefined, { 'x-test-owner': 'foreign' })).status, 404);
    assert.equal(f.adapter.submits, 0);
  } finally { await f.close(); }
});

test('library asset use history pages individual save operations, including provisional pins', async () => {
  const f = await setup(); f.adapter.getWorkflow = async () => null;
  try {
    const sid = (await f.request('/sessions', 'POST', { name: 'References' })).body.session.id;
    const path = `/sessions/${sid}`;
    const ref = { filename: 'reference.png', subfolder: '', type: 'input' as const };
    f.adapter.files.set(mediaKey(ref), await sharp({ create: { width: 16, height: 16, channels: 3, background: 'green' } }).png().toBuffer());
    const asset = (await f.request(`${path}/assets`, 'POST', { requestId: randomUUID(), file: { ...ref, kind: 'image' } })).body.asset;
    const created = await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'Video', template: { templateId: 'h3-ref-image', text: 'wave', references: [{ nodeId: '17', inputName: 'image', assetId: asset.id }] } });
    const ids: string[] = [];
    for (const name of ['first', 'second']) {
      const intent = { requestId: randomUUID(), revision: 1, mode: 'create', startedBy: 'test', target: { serverId: 'server', workflowId: randomUUID(), filename: `${name}.json`, name } }; ids.push(intent.requestId);
      assert.equal((await f.request(`${path}/drafts/${created.body.draft.id}/library-saves`, 'POST', intent)).status, 201);
      assert.equal((await f.request(`${path}/library-saves/${intent.requestId}/prepare`, 'POST', {})).status, 200);
      assert.equal((await f.request(`${path}/library-saves/${intent.requestId}/cancel`, 'POST', {})).status, 200);
    }
    const first = await f.request(`${path}/assets/${asset.id}/library-uses?limit=1`);
    assert.equal(first.body.items[0].saves[0].operationId, ids[1]); assert.equal(first.body.items[0].saves[0].state, 'failed');
    const second = await f.request(`${path}/assets/${asset.id}/library-uses?limit=1&before=${first.body.nextCursor}`);
    assert.equal(second.body.items[0].saves[0].operationId, ids[0]); assert.equal(second.body.nextCursor, undefined);
    assert.equal((await f.request(`${path}/assets/${asset.id}/library-uses`, 'GET', undefined, { 'x-test-owner': 'foreign' })).status, 404);
  } finally { await f.close(); }
});

test('discard serializes with delayed saves, keeps committed history, and cancels local forks without generation', async () => {
  const f = await setup();
  let release: (() => void) | undefined;
  try {
    const sid = (await f.request('/sessions', 'POST', { name: 'Discard' })).body.session.id;
    const path = `/sessions/${sid}`;
    const a = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'Image', template: { templateId: 'z-image-turbo', text: 'original' } })).body;
    const endpoint = `${path}/drafts/${a.draft.id}`;
    const pending = { requestId: randomUUID(), sourceRevision: 1, expectedHeadRevision: 1, summary: 'local', canvas: a.revision.canvas, bindings: [] };
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const objectInfo = f.adapter.getObjectInfo.bind(f.adapter);
    f.adapter.getObjectInfo = async () => { entered(); await gate; return objectInfo(); };
    const late = f.request(`${endpoint}/versions`, 'POST', pending);
    await waiting;
    assert.equal((await f.request(`${endpoint}/discard-local`, 'POST', { pending }, { 'x-test-owner': 'other' })).status, 404);
    assert.equal((await f.request(`${endpoint}/discard-local`, 'POST', { pending }, { 'x-agent-server-id': 'replacement' })).status, 409);
    const canceled = await f.request(`${endpoint}/discard-local`, 'POST', { pending });
    assert.equal(canceled.status, 200); assert.equal(canceled.body.revision.revision, 1);
    release(); assert.equal((await late).status, 409);
    assert.equal((await f.request(`${endpoint}/versions`, 'POST', pending)).status, 409);
    assert.deepEqual((await f.request(`${endpoint}/discard-local`, 'POST', { pending })).body, canceled.body);
    assert.equal((await f.request(`${endpoint}/discard-local`, 'POST', { pending: { ...pending, summary: 'different' } })).status, 409);
    const saved = { ...pending, requestId: randomUUID() };
    assert.equal((await f.request(`${endpoint}/versions`, 'POST', saved)).status, 201);
    const fork = { requestId: randomUUID(), sourceRevision: 1, name: 'direction', canvas: a.revision.canvas, bindings: [] };
    const created = await f.request(`${endpoint}/fork-local`, 'POST', fork);
    const settled = await f.request(`${endpoint}/discard-local`, 'POST', { pending: saved, fork });
    assert.equal(settled.status, 200); assert.equal(settled.body.savedRevision, 2);
    assert.deepEqual(settled.body.forkedTo, { draftId: created.body.draft.id, revision: 1 });
    assert.equal(settled.body.revision.revision, 2);
    const unsent = { ...fork, requestId: randomUUID() };
    assert.equal((await f.request(`${endpoint}/discard-local`, 'POST', { fork: unsent })).status, 200);
    assert.equal((await f.request(`${endpoint}/fork-local`, 'POST', unsent)).status, 409);
    // Canceling both requests is atomic: a mismatched second identity must not cancel the first.
    const atomic = { ...pending, requestId: randomUUID(), expectedHeadRevision: 2 };
    assert.equal((await f.request(`${endpoint}/discard-local`, 'POST', { pending: atomic, fork: { ...fork, name: 'mismatched' } })).status, 409);
    assert.equal((await f.request(`${endpoint}/versions`, 'POST', atomic)).status, 201);
    const invalid = { ...pending, requestId: randomUUID(), canvas: { ...pending.canvas, version: 99 } };
    assert.equal((await f.request(`${endpoint}/versions`, 'POST', invalid)).status, 400);
    assert.equal((await f.request(`${endpoint}/discard-local`, 'POST', { pending: invalid })).status, 200);
    assert.equal((await f.request(`${path}/drafts`)).body.items.length, 2);
    assert.equal((await f.request(`${endpoint}/versions`)).body.items.length, 3);
    assert.equal((await f.request(`${path}/runs`)).body.items.length, 0); assert.equal(f.adapter.submits, 0);
  } finally { release?.(); await f.close(); }
});

test('local fork HTTP saves supplied edits and bindings with fixed provenance, enforcing scope and request identity', async () => {
  const f = await setup();
  try {
    const sid = (await f.request('/sessions', 'POST', { name: 'Local recovery' })).body.session.id; const path = `/sessions/${sid}`;
    const a = (await f.request(`${path}/drafts`, 'POST', { source: 'template', requestId: randomUUID(), name: 'Image', template: { templateId: 'z-image-turbo', text: 'original' } })).body;
    const local = structuredClone(a.revision.canvas); local.nodes.find((node: { id: number }) => node.id === 5).widgets_values[0] = 'local unsaved cat';
    const input = { requestId: randomUUID(), sourceRevision: 1, name: 'Local direction', canvas: local, bindings: [] };
    const endpoint = `${path}/drafts/${a.draft.id}/fork-local`;
    assert.equal((await f.request(endpoint, 'POST', input, { 'x-agent-schema-version': '1' })).status, 426);
    assert.equal((await f.request(endpoint, 'POST', input, { 'x-test-owner': 'other' })).status, 404);
    assert.equal((await f.request(endpoint, 'POST', { ...input, bindings: undefined })).status, 400);
    const fork = await f.request(endpoint, 'POST', input); assert.equal(fork.status, 201);
    assert.deepEqual(fork.body.revision.canvas, local); assert.deepEqual(fork.body.draft.forkedFrom, { draftId: a.draft.id, revision: 1 });
    assert.deepEqual((await f.request(endpoint, 'POST', input)).body, fork.body);
    assert.equal((await f.request(endpoint, 'POST', { ...input, name: 'different retry' })).status, 409);
    assert.equal((await f.request(`${path}/drafts/${a.draft.id}`)).body.draft.headRevision, 1);
    assert.equal(f.adapter.submits, 0);
  } finally { await f.close(); }
});
