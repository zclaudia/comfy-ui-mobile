/** Explicit opt-in: real configured LLM and ComfyUI. Use an isolated V2 Gateway store. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

if (process.env.E2E_WORKSPACE_LIVE !== '1') throw new Error('E2E_WORKSPACE_LIVE=1 required');
const url = process.env.E2E_GATEWAY_URL;
const token = process.env.E2E_GATEWAY_TOKEN;
if (!url || !token) throw new Error('Explicit E2E_GATEWAY_URL and E2E_GATEWAY_TOKEN required');
const directory = new URL(`../output/workspace-live/${randomUUID()}/`, import.meta.url);
await mkdir(directory, { recursive: true });
const report = { started: new Date().toISOString(), rounds: [] };
const persist = () => writeFile(new URL('report.json', directory), JSON.stringify(report, null, 2));
let serverId;
async function api(path, body) {
  const response = await fetch(`${url}/api/gateway/agent${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'X-Agent-Schema-Version': '2', ...(serverId ? { 'X-Agent-Server-Id': encodeURIComponent(serverId) } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `HTTP ${response.status} ${path}: ${response.ok ? '' : await response.text()}`);
  return response.json();
}
let session;
async function round(message, context = {}) {
  const requestId = randomUUID();
  const item = { message, context, requestId }; report.rounds.push(item); await persist();
  // No automatic POST retry or new request id after an uncertain submission.
  const accepted = await api(`/sessions/${session.id}/messages`, { message, context, requestId });
  item.taskId = accepted.taskId; await persist();
  let lastState;
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const snapshot = await api(`/sessions/${session.id}`);
    const task = snapshot.tasks.find(task => task.id === accepted.taskId);
    item.snapshot = snapshot; await persist();
    if (task?.state !== lastState) { lastState = task?.state; console.log(`Round ${report.rounds.length}: ${lastState}`); }
    if (['completed', 'failed', 'cancelled', 'waiting_user'].includes(lastState)) {
      let cursor = snapshot.cursor;
      while (cursor < snapshot.highWater) {
        const page = await api(`/sessions/${session.id}?after=${cursor}`);
        assert.ok(page.cursor > cursor, 'Event pagination must advance');
        snapshot.events.push(...page.events.filter(event => event.seq <= snapshot.highWater));
        cursor = page.cursor;
      }
      item.eventsComplete = true; await persist();
      assert.equal(lastState, 'completed', `Round stopped: ${lastState}; inspect report before any continuation`);
      return snapshot;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Observation deadline reached; task may still be active. Inspect persisted taskId; do not resubmit.');
}
try {
  const status = await api('/status'); assert.equal(status.agentSchemaVersion, 2); assert.equal(status.providerReady, true); serverId = status.serverId;
  report.status = status;
  ({ session } = await api('/sessions', { name: `WorkspaceLive-${Date.now()}` })); report.sessionId = session.id;
  console.log(`Evidence: ${directory.pathname}\nSession: ${session.id}`); await persist();
  let snapshot = await round('请用 Z-Image Turbo 生成一张 512×512 的橘猫图片：橘猫坐在室内窗边，温暖阳光。只生成一次。');
  assert.equal(snapshot.drafts.items.length, 1); assert.equal(snapshot.runs.items.length, 1);
  const image = snapshot.drafts.items[0]; const imageRun1 = snapshot.runs.items[0]; assert.equal(imageRun1.state, 'succeeded');
  const imageAsset1 = (await api(`/sessions/${session.id}/runs/${imageRun1.id}/assets`)).items.find(asset => asset.kind === 'image'); assert.ok(imageAsset1);
  snapshot = await round('基于选中的橘猫图片，用 H3 参考图视频模板生成一个短预览：猫轻轻挥爪。864×480、22 帧，保留模板其他设置，只生成一次。', { action: 'generate_video', selectedAssetIds: [imageAsset1.id] });
  assert.equal(snapshot.drafts.items.length, 2); assert.equal(snapshot.runs.items.length, 2);
  const video = snapshot.drafts.items.find(draft => draft.id !== image.id); const videoRun1 = snapshot.runs.items.find(run => run.draftId === video.id); assert.equal(videoRun1.state, 'succeeded');
  const originalVideoRun = (await api(`/sessions/${session.id}/runs/${videoRun1.id}`)).run;
  assert.equal(originalVideoRun.inputManifest[0].assetId, imageAsset1.id);
  snapshot = await round('回头调整这张橘猫图片：背景改成海边，保留橘猫和原来的尺寸，只重新生成图片一次。', { action: 'edit_source', targetDraftId: image.id, sourceRevision: imageRun1.revision });
  assert.equal(snapshot.drafts.items.length, 2); assert.equal(snapshot.runs.items.length, 3);
  assert.equal(snapshot.runs.items.filter(run => run.draftId === video.id).length, 1);
  assert.deepEqual((await api(`/sessions/${session.id}/runs/${videoRun1.id}`)).run, originalVideoRun);
  const imageRun2 = snapshot.runs.items.find(run => run.draftId === image.id && run.id !== imageRun1.id); assert.equal(imageRun2.state, 'succeeded');
  const imageAsset2 = (await api(`/sessions/${session.id}/runs/${imageRun2.id}/assets`)).items.find(asset => asset.kind === 'image'); assert.ok(imageAsset2);
  snapshot = await round('用选中的海边橘猫新图更新这个视频，保持挥爪动作及其他视频设置，只生成一次新版视频。', { targetDraftId: video.id, sourceRevision: videoRun1.revision, selectedAssetIds: [imageAsset2.id] });
  assert.equal(snapshot.drafts.items.length, 2); assert.equal(snapshot.runs.items.length, 4);
  const videoRun2 = snapshot.runs.items.find(run => run.draftId === video.id && run.id !== videoRun1.id); assert.equal(videoRun2.state, 'succeeded');
  const updatedVideoRun = (await api(`/sessions/${session.id}/runs/${videoRun2.id}`)).run;
  assert.equal(updatedVideoRun.inputManifest[0].assetId, imageAsset2.id);
  assert.deepEqual((await api(`/sessions/${session.id}/runs/${videoRun1.id}`)).run, originalVideoRun);
  assert.ok(snapshot.drafts.items.every(draft => draft.headRevision === 2));
  const videoVersions = await Promise.all([videoRun1, videoRun2].map(run => api(`/sessions/${session.id}/drafts/${video.id}/versions/${run.revision}`)));
  const technicalSettings = version => {
    const canvas = structuredClone(version.canvas);
    const loader = canvas.nodes.find(node => node.type === 'LoadImage'); assert.ok(loader);
    loader.widgets_values[0] = '<reference>';
    if (loader.widgets_values_named?.image) loader.widgets_values_named.image = '<reference>';
    const motion = canvas.nodes.find(node => node.id === 7); assert.ok(motion?.widgets_values);
    motion.widgets_values[0] = '<motion and scene prompt>';
    if (motion.widgets_values_named?.prompt) motion.widgets_values_named.prompt = '<motion and scene prompt>';
    return canvas;
  };
  assert.deepEqual(technicalSettings(videoVersions[0]), technicalSettings(videoVersions[1]), 'Video technical settings stay fixed; scene prompt may follow the edited reference');
  report.videoVersions = videoVersions; report.videoParametersUnchanged = true;
  report.originalVideoRun = originalVideoRun; report.updatedVideoRun = updatedVideoRun;
  report.passed = true; report.note = 'Real execution and references checked. Visual quality, ambiguity and repeated trials need separate review.';
  console.log('Four real rounds passed');
} catch (error) { report.error = String(error); process.exitCode = 1; console.error(report.error); }
finally { await persist(); console.log(`Report: ${new URL('report.json', directory).pathname}`); }
