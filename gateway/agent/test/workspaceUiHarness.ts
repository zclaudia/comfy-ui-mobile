/** Isolated interactive V2 fixture. Every model response and media output is synthetic; no external model or GPU. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { MockLanguageModelV3 } from 'ai/test';
import { WebSocketServer } from 'ws';
import { AgentService } from '../service.js';
import { handleAgentRequest } from '../routes.js';
import { activeStates } from '../store.js';
import { createGatewayServer } from '../../server.js';
import { loadGatewayConfig } from '../../config.js';
import { WorkspaceComfy, mediaKey } from './workspaceFixture.js';
import { digest } from '../workspace/digest.js';
import { createModelWorkflow } from '../modelProfiles.js';
import { migrateLegacyWorkspace } from '../workspace/migration.js';
import { SHARED_AGENT_OWNER } from '../../auth.js';

const directory = mkdtempSync(join(tmpdir(), 'workspace-ui-'));
const videoPath = join(directory, 'synthetic.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=192x256:rate=12', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
class PreviewComfy extends WorkspaceComfy {
  library = new Map<string, { content: Record<string, unknown>; etag: string; modified: number }>();
  override async getWorkflow(filename: string) { return structuredClone(this.library.get(filename) ?? null); }
  override async submit(...args: Parameters<WorkspaceComfy['submit']>) {
    const result = await super.submit(...args);
    const isVideo = Object.values(args[0] as Record<string, { class_type: string }>).some(node => node.class_type === 'MiniMaxH3ReferenceToVideo');
    const ref = { filename: `synthetic-${this.submits}.${isVideo ? 'mp4' : 'png'}`, subfolder: '', type: 'output' as const };
    this.files.set(mediaKey(ref), isVideo ? readFileSync(videoPath) : await sharp({ create: { width: 192, height: 256, channels: 3, background: this.submits > 2 ? '#16a3ad' : '#4169e1' } }).png().toBuffer());
    this.history[result.promptId].outputs = { '99': { images: [ref] } };
    return result;
  }
}
const adapter = new PreviewComfy(); adapter.complete = true;
let uploadAttempts = 0;
const comfy = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname === '/view') {
    const ref = { filename: url.searchParams.get('filename')!, subfolder: url.searchParams.get('subfolder') ?? '', type: url.searchParams.get('type') ?? 'output' };
    const bytes = adapter.files.get(mediaKey(ref));
    res.statusCode = bytes ? 200 : 404; res.setHeader('content-type', ref.filename.endsWith('.mp4') ? 'video/mp4' : 'image/png'); res.end(bytes); return;
  }
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 21 * 1024 * 1024) { res.statusCode = 413; res.end(JSON.stringify({ error: 'fixture upload size limit' })); return; } chunks.push(chunk); }
    uploadAttempts++;
    if (process.env.WORKSPACE_UI_UPLOAD_FAIL_ONCE === '1' && uploadAttempts === 1) { res.statusCode = 503; res.end(JSON.stringify({ error: 'intentional first-upload failure' })); return; }
    try {
      const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
      const file = form.get('image');
      if (!(file instanceof File)) throw new Error('missing image file');
      // Keep actual multipart bytes and return a renamed path, as ComfyUI may do on a filename collision.
      const filename = `uploaded-${randomUUID()}-${file.name}`; const subfolder = String(form.get('subfolder') ?? '');
      const bytes = new Uint8Array(await file.arrayBuffer());
      adapter.files.set(mediaKey({ filename, subfolder, type: 'input' }), bytes);
      console.log(JSON.stringify({ fixtureUpload: { filename, subfolder, size: bytes.length, attempt: uploadAttempts } }));
      res.end(JSON.stringify({ name: filename, subfolder, type: 'input' }));
    } catch { res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid fixture multipart upload' })); }
    return;
  }
  if (url.pathname === '/object_info') { res.end(JSON.stringify(adapter.info)); return; }
  if (url.pathname === '/queue') { res.end(JSON.stringify(await adapter.getQueue())); return; }
  if (url.pathname === '/history') { res.end(JSON.stringify(adapter.history)); return; }
  if (url.pathname === '/comfymobile/api/workflows/list') { res.end(JSON.stringify({ status: 'success', workflows: [...adapter.library].map(([filename, file]) => ({ filename, name: filename.replace(/\.json$/, ''), etag: file.etag, modified: file.modified })) })); return; }
  if (url.pathname.startsWith('/comfymobile/api/workflows/content/')) {
    const filename = decodeURIComponent(url.pathname.slice('/comfymobile/api/workflows/content/'.length)); const file = adapter.library.get(filename);
    res.statusCode = file ? 200 : 404; res.end(JSON.stringify(file ? { status: 'success', filename, ...file } : { status: 'error', message: 'missing' })); return;
  }
  if (url.pathname === '/comfymobile/api/workflows/save' && req.method === 'POST') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); const current = adapter.library.get(body.filename);
    if (body.expected_etag ? current?.etag !== body.expected_etag : !!current) { res.statusCode = 409; res.end(JSON.stringify({ status: 'error', code: 'workflow_conflict' })); return; }
    const file = { content: body.content, etag: digest(body.content), modified: Date.now() / 1000 }; adapter.library.set(body.filename, file);
    res.end(JSON.stringify({ status: 'success', filename: body.filename, etag: file.etag, modified: file.modified })); return;
  }
  if (url.pathname === '/system_stats') { res.end(JSON.stringify({ system: { os: 'UI fixture' }, devices: [] })); return; }
  res.end('{}');
});
const sockets = new WebSocketServer({ server: comfy });
sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: 'workspace-ui' } })));
comfy.listen(0, '127.0.0.1'); await once(comfy, 'listening');
const config = { ...loadGatewayConfig({ GATEWAY_AUTH_TOKEN: 'local-workspace-ui-test-token', GATEWAY_DEVICE_STORE: join(directory, 'devices.json'), COMFYUI_URL: `http://127.0.0.1:${(comfy.address() as { port: number }).port}` }), host: '127.0.0.1', port: Number(process.env.WORKSPACE_UI_PORT ?? 53023),
  allowedOrigins: new Set([process.env.WORKSPACE_UI_ORIGIN ?? 'http://127.0.0.1:5187']),
  agentStorePath: join(directory, 'agent.sqlite'), agentModel: '模拟模型 · 无外部调用', agentPollMs: 250, agentContextWindow: 131072, agentWorkspace: { directory: join(directory, 'assets'), serverId: 'ui-fixture' } };
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } };
const call = (toolName: string, input: unknown) => ({ content: [{ type: 'tool-call' as const, toolName, toolCallId: randomUUID(), input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage, warnings: [] });
const steps = new Map<string, number>();
const model = new MockLanguageModelV3({ doGenerate: async options => {
  const task = service.store.tasks().find(task => activeStates.includes(task.state))!;
  if (task.message.includes('仅保存上传素材')) {
    const answer = '模拟验收：已保留上传素材，本轮不生成。';
    return options.toolChoice?.type === 'required' ? call('finish_response', { answer }) : { content: [{ type: 'text' as const, text: answer }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] };
  }
  if (options.toolChoice?.type === 'required') return call('finish_response', { answer: '模拟生成已完成。这是界面验证素材，没有调用外部模型或 GPU。' });
  const step = steps.get(task.id) ?? 0; steps.set(task.id, step + 1);
  const repo = service.workspace!.repository; const context = task.workspace!.requestContext;
  const target = context.targetDraftId ? repo.draft(task.sessionId, context.targetDraftId) : undefined;
  const selected = context.selectedAssetIds?.[0]; const video = context.action === 'generate_video' || (!!selected && /视频|video/i.test(task.message)); const rerun = context.action === 'rerun';
  const op = (key: string) => repo.operations(task.sessionId, task.id).find(op => op.stepKey === key)!.id;
  if (task.message.includes('选择测试')) {
    if (step === 0) return call('request_selection', { requestId: 'choose', question: '选择要调整的创作', candidates: repo.drafts(task.sessionId).items.map(draft => ({ type: 'draft', draftId: draft.id, revision: draft.headRevision })) });
    return { content: [{ type: 'text' as const, text: '已收到选择，本次只验证选择交互。' }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] };
  }
  if (step === 0) return call('plan_operations', { steps: [{ stepKey: 'change', kind: rerun ? 'submit_preview' : target ? 'edit_workflow' : 'create_workflow', ...(target ? { targetDraftId: target.id } : {}) }] });
  if (step === 1) {
    if (rerun) return call('submit_preview', { operationId: op('change'), draftId: target!.id, revision: context.sourceRevision ?? target!.headRevision });
    if (target) return call('edit_workflow', { operationId: op('change'), draftId: target.id, sourceRevision: context.sourceRevision ?? target.headRevision, expectedHeadRevision: target.headRevision, summary: '测试画面调整', ...(selected && target.outputKinds.includes('video') ? { bindingChanges: [{ nodeId: '17', inputName: 'image', assetId: selected }] } : { operations: [{ op: 'set_input', nodeId: '5', input: 'text', value: 'cat on beach' }] }) });
    return call('create_workflow', { operationId: op('change'), templateId: video ? 'h3-ref-image' : 'z-image-turbo', name: video ? '挥手视频' : '猫咪图片', text: video ? 'cat waves' : 'cat', ...(video ? { references: [{ nodeId: '17', inputName: 'image', assetId: selected }] } : {}) });
  }
  const current = target ?? repo.drafts(task.sessionId).items[0];
  if (!rerun && step === 2) return call('plan_operations', { steps: [{ stepKey: 'render', kind: 'submit_preview', targetDraftId: current.id }] });
  if (!rerun && step === 3) return call('submit_preview', { operationId: op('render'), draftId: current.id, revision: current.headRevision });
  return { content: [{ type: 'text' as const, text: '模拟生成已完成。这是界面验证素材，没有调用外部模型或 GPU。' }], finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] };
} });
const service: AgentService = new AgentService(config, { model, adapter });
if (process.env.WORKSPACE_UI_LEGACY === '1') {
  const legacy = service.store.create(SHARED_AGENT_OWNER, 'Legacy migration acceptance', createModelWorkflow(adapter.info, { profileId: 'z-image-turbo', text: 'legacy original cat' }));
  const uploaded = { filename: 'legacy-upload.png', subfolder: '', type: 'input' as const, kind: 'image' as const };
  adapter.files.set(mediaKey(uploaded), await sharp({ create: { width: 192, height: 256, channels: 3, background: '#e0a020' } }).png().toBuffer());
  const task = service.store.enqueue(legacy.id, randomUUID(), 'Historical cat picture with an uploaded reference', 60_000, [uploaded]);
  service.store.update({ ...task, state: 'completed' });
  service.store.event(legacy.id, task.id, 'workflow', { version: 1, summary: 'legacy original cat' });
  service.store.event(legacy.id, task.id, 'state', { state: 'waiting_comfy', version: 1, promptId: 'legacy-generation' });
  const output = { filename: 'legacy-result.png', subfolder: '', type: 'output' as const, kind: 'image' as const };
  adapter.files.set(mediaKey(output), await sharp({ create: { width: 192, height: 256, channels: 3, background: '#7754c2' } }).png().toBuffer());
  service.store.event(legacy.id, task.id, 'result', { version: 1, promptId: 'legacy-generation', success: true, outputs: [output, output] });
  service.store.event(legacy.id, task.id, 'result', { version: 99, promptId: 'unmapped', success: true, outputs: [{ ...output, filename: 'unknown-original.png' }] });
  service.store.event(legacy.id, task.id, 'state', { state: 'completed' });
  service.store.commitVersion(legacy.id, 1, createModelWorkflow(adapter.info, { profileId: 'z-image-turbo', text: 'legacy newer head' }), 'newer saved workflow');
  migrateLegacyWorkspace(service.workspace!.repository, config.agentWorkspace.serverId);
  console.log(`WORKSPACE_LEGACY_SESSION=${legacy.id}`);
}
// Keep error classes shared with the injected source service; mixing the dist handler turns expected 409s into 500s.
const gateway = createGatewayServer(config, { agentService: service, agentRequestHandler: handleAgentRequest }); const address = await gateway.start();
console.log(`WORKSPACE_UI_URL=http://127.0.0.1:${address.port}`);
console.log(`WORKSPACE_UI_DIRECTORY=${directory}`);
const stop = async () => { await gateway.stop(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); comfy.closeAllConnections(); comfy.close(); rmSync(directory, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
