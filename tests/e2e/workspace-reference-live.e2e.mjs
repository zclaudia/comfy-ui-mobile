/** Explicit opt-in, isolated V2 Gateway: real batch selection and independent fork. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

if (process.env.E2E_WORKSPACE_LIVE !== '1') throw new Error('E2E_WORKSPACE_LIVE=1 required');
const url = process.env.E2E_GATEWAY_URL;
const token = process.env.E2E_GATEWAY_TOKEN;
if (!url || !token) throw new Error('Explicit E2E_GATEWAY_URL and E2E_GATEWAY_TOKEN required');
const directory = new URL(`../output/workspace-live/reference-${randomUUID()}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const report = { started: new Date().toISOString(), rounds: [] };
const persist = () => writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2));
let serverId;
let session;
async function api(path, body) {
  const response = await fetch(`${url}/api/gateway/agent${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Agent-Schema-Version': '2', ...(serverId ? { 'X-Agent-Server-Id': encodeURIComponent(serverId) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `HTTP ${response.status} ${path}: ${response.ok ? '' : await response.text()}`);
  return response.json();
}
async function round(message, context = {}, maximumRuns) {
  const item = { message, context, requestId: randomUUID() };
  report.rounds.push(item); await persist();
  const accepted = await api(`/sessions/${session.id}/messages`, { message, context, requestId: item.requestId });
  item.taskId = accepted.taskId; await persist();
  let lastState;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const snapshot = await api(`/sessions/${session.id}`);
    item.snapshot = snapshot; await persist();
    if (snapshot.runs.items.length > maximumRuns) {
      await api(`/sessions/${session.id}/cancel`, { taskId: item.taskId });
      throw new Error('Unexpected extra Run; task cancelled, inspect submitted GPU work separately');
    }
    const state = snapshot.tasks.find(task => task.id === item.taskId)?.state;
    if (state !== lastState) { lastState = state; console.log(`Round ${report.rounds.length}: ${state}`); }
    if (['completed', 'failed', 'cancelled', 'waiting_user'].includes(state)) {
      let cursor = snapshot.cursor;
      while (cursor < snapshot.highWater) {
        const page = await api(`/sessions/${session.id}?after=${cursor}`);
        assert.ok(page.cursor > cursor, 'Event pagination must advance');
        snapshot.events.push(...page.events.filter(event => event.seq <= snapshot.highWater));
        cursor = page.cursor;
      }
      item.eventsComplete = true; await persist();
      assert.equal(state, 'completed', 'Inspect the saved task before any continuation');
      return snapshot;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Observation deadline; task may still be active. Do not resubmit.');
}
try {
  const status = await api('/status');
  assert.equal(status.agentSchemaVersion, 2); assert.equal(status.providerReady, true);
  serverId = status.serverId; report.status = status;
  ({ session } = await api('/sessions', { name: `WorkspaceReference-${Date.now()}` }));
  report.sessionId = session.id; await persist();
  console.log(`Evidence: ${directory.pathname}\nSession: ${session.id}`);
  let snapshot = await round('用 Z-Image Turbo 一次生成两张 512×512 的橘猫图片，背景是海边沙滩。请用同一工作流、batch_size=2，只提交一次生成，不要分两次运行。', {}, 1);
  assert.equal(snapshot.drafts.items.length, 1); assert.equal(snapshot.runs.items.length, 1);
  const original = snapshot.drafts.items[0];
  const imageRun = (await api(`/sessions/${session.id}/runs/${snapshot.runs.items[0].id}`)).run;
  assert.equal(imageRun.state, 'succeeded');
  const images = (await api(`/sessions/${session.id}/runs/${imageRun.id}/assets`)).items.filter(asset => asset.kind === 'image');
  assert.equal(images.length, 2); assert.deepEqual(images.map(asset => asset.displayOrdinal), [1, 2]);
  report.batch = { imageRun, images }; await persist();

  // Deliberately do not preselect an asset: the model must resolve the ordinal from this batch.
  snapshot = await round('用刚才这一批里的第二张图片生成一个 H3 参考图视频：橘猫轻轻挥爪，保留海边背景。864×480、22 帧，其他设置沿用模板，只生成一次视频，不重新生成图片。', {}, 2);
  assert.equal(snapshot.drafts.items.length, 2); assert.equal(snapshot.runs.items.length, 2);
  const videoSummary = snapshot.runs.items.find(run => run.draftId !== original.id);
  assert.ok(videoSummary);
  const videoRun = (await api(`/sessions/${session.id}/runs/${videoSummary.id}`)).run;
  assert.equal(videoRun.state, 'succeeded');
  assert.equal(videoRun.inputManifest[0].assetId, images[1].id);
  assert.deepEqual((await api(`/sessions/${session.id}/runs/${imageRun.id}`)).run, imageRun);
  report.videoRun = videoRun; await persist();

  snapshot = await round('从这张图片的生成版本另做一个方向，把背景改成森林。保留原图片工作流，建立独立的新图片草稿。只保存提示词修改，暂时不要生成图片或视频。', { action: 'edit_source', targetDraftId: original.id, sourceRevision: imageRun.revision, selectedAssetIds: [images[1].id] }, 2);
  assert.equal(snapshot.drafts.items.length, 3); assert.equal(snapshot.runs.items.length, 2);
  assert.equal(snapshot.drafts.items.find(draft => draft.id === original.id).headRevision, original.headRevision);
  const fork = snapshot.drafts.items.find(draft => draft.id !== original.id && draft.id !== videoRun.draftId);
  assert.deepEqual(fork.forkedFrom, { draftId: original.id, revision: imageRun.revision });
  const revision = await api(`/sessions/${session.id}/drafts/${fork.id}/versions/${fork.headRevision}`);
  assert.match(JSON.stringify(revision.canvas.nodes.find(node => node.id === 5)?.widgets_values), /forest|森林/i);
  assert.deepEqual((await api(`/sessions/${session.id}/runs/${videoRun.id}`)).run, videoRun);
  report.fork = { draft: fork, revision }; report.passed = true;
  report.note = 'Real ordinal selection, execution and fork provenance checked; visual quality requires separate review.';
  console.log('Batch second-image reference and independent fork passed');
} catch (error) { report.error = String(error); process.exitCode = 1; console.error(report.error); }
finally { await persist(); console.log(`Report: ${new URL('report.json', directory).pathname}`); }
