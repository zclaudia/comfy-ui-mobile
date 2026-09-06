/** Explicit opt-in: calls the configured LLM and uploads/runs a tiny ComfyUI image-copy fixture. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { loadGatewayConfig } from '../../config.js';
import { AgentService } from '../../dist/agent/service.js';

if (process.env.AGENT_LIVE_TEST !== '1') throw new Error('Set AGENT_LIVE_TEST=1 to explicitly enable external calls');
const config = loadGatewayConfig();
const directory = resolve('tests/output/agent-live', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(directory, { recursive: true });
const filename = `agent-smoke-${randomUUID()}.png`;
const uploadUrl = new URL('/upload/image', config.comfyUrl);
if (config.comfyAuthToken) uploadUrl.searchParams.set('token', config.comfyAuthToken);
// A generated fixture; never uploads an existing user's image to the model or ComfyUI.
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 50, g: 100, b: 180 } } }).png().toBuffer();
const form = new FormData(); form.set('image', new Blob([png], { type: 'image/png' }), filename); form.set('overwrite', 'false');
const upload = await fetch(uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
if (!upload.ok) throw new Error(`Fixture upload failed: ${upload.status}`);
const uploaded = await upload.json() as { name: string; subfolder?: string };
const imageName = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
const canvas = JSON.parse(readFileSync(new URL('../../../tests/samples/workflows/live-e2e-workflow.json', import.meta.url), 'utf8'));
canvas.nodes.find((n: any) => n.type === 'LoadImage').widgets_values[0] = '__agent_missing_fixture__.png';
canvas.nodes.find((n: any) => n.type === 'SaveImage').widgets_values[0] = 'ComfyMobile/AgentLiveSmoke';
const service = new AgentService({ ...config, agentStorePath: resolve(directory, 'agent.sqlite'), agentMaxSteps: 8, agentMaxPreviews: 1, agentTimeoutMs: 240000 });
try {
  const session = await service.createSession('live-test', 'MiniMax real provider smoke', canvas);
  const task = service.enqueue(session.id, 'live-test', randomUUID(), `这是专用联调工作流，只复制一张测试图片，不需要生成新内容。LoadImage 的文件名故意填错了，请将它修正为 ${imageName}，保留现有输出前缀，校验，实际试跑一次并保存修复后的版本。只允许一次预览，最后用中文简要报告实际结果。`);
  console.log(JSON.stringify({ phase: 'started', taskId: task.id, reportDirectory: directory }));
  let cursor = 0;
  while (true) {
    await service.tick();
    const snapshot = service.snapshot(session.id, 'live-test', cursor); cursor = snapshot.cursor;
    const current = service.store.task(task.id);
    console.log(JSON.stringify({ state: current.state, steps: current.steps, previews: current.previews, events: snapshot.events.map(e => ({ kind: e.kind, ...(e.kind === 'tool' ? { tool: (e.data as any).name } : {}) })) }));
    if (['completed', 'failed', 'cancelled'].includes(current.state)) {
      const result = current.result as any;
      const saved = service.store.version(session.id)?.saved === true;
      const report = { model: config.agentModel, taskId: task.id, state: current.state, steps: current.steps, previews: current.previews, result, saved, error: current.error, events: service.snapshot(session.id, 'live-test', 0).events };
      writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ phase: 'finished', state: current.state, executionSuccess: result?.success, saved, report: resolve(directory, 'report.json') }));
      if (current.state !== 'completed' || !result?.success || !saved) process.exitCode = 1;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await service.stop(); }
