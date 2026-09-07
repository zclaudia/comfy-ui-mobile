/** Local UI verification only: synthetic model responses and synthetic ComfyUI outputs. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { WebSocketServer } from 'ws';
import { AgentService } from '../../dist/agent/service.js';
import { createGatewayServer } from '../../server.js';
import { loadGatewayConfig } from '../../config.js';
import { info } from './fixture.js';
const runs: Record<string, unknown> = {};
const comfy = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname === '/view') {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#2563eb"/><stop offset="1" stop-color="#6d28d9"/></linearGradient></defs><rect width="512" height="768" fill="url(#g)"/><circle cx="256" cy="290" r="120" fill="#c4b5fd" opacity=".45"/><text x="256" y="505" text-anchor="middle" fill="white" font-size="32">MVP TEST PREVIEW</text><text x="256" y="550" text-anchor="middle" fill="#c4b5fd" font-size="20">Synthetic output · no GPU</text></svg>'); return;
  }
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    // Minimal multipart parse: only the filename matters for the synthetic input folder.
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const name = /filename="([^"]+)"/.exec(Buffer.concat(buffers).toString('latin1'))?.[1] ?? 'upload.bin';
    res.end(JSON.stringify({ name, subfolder: 'agent-chat', type: 'input' })); return;
  }
  if (url.pathname === '/comfymobile/api/workflows/list') { res.end(JSON.stringify({ status: 'success', workflows: [] })); return; }
  if (url.pathname === '/object_info') { res.end(JSON.stringify(info)); return; }
  if (url.pathname === '/prompt' && req.method === 'POST') {
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString());
    const id = `test-${Object.keys(runs).length + 1}`;
    runs[id] = { prompt: [0, id, body.prompt, body.extra_data], status: { completed: true, status_str: 'success' }, outputs: { '7': { images: [{ filename: 'preview.svg', subfolder: '', type: 'output' }] } } };
    res.end(JSON.stringify({ prompt_id: id, number: 0 })); return;
  }
  if (url.pathname.startsWith('/history/')) { const id = url.pathname.split('/').at(-1)!; res.end(JSON.stringify({ [id]: runs[id] })); return; }
  if (url.pathname === '/history') { res.end(JSON.stringify(runs)); return; }
  if (url.pathname === '/queue') { res.end(JSON.stringify({ queue_running: [], queue_pending: [] })); return; }
  res.end('{}');
});
const sockets = new WebSocketServer({ server: comfy });
sockets.on('connection', socket => socket.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: 'ui-test' } })));
comfy.listen(0, '127.0.0.1'); await once(comfy, 'listening');
const folder = mkdtempSync(join(tmpdir(), 'agent-ui-'));
const config = { ...loadGatewayConfig({ GATEWAY_AUTH_TOKEN: 'local-agent-ui-test-token', GATEWAY_DEVICE_STORE: join(folder, 'devices.json'), COMFYUI_URL: `http://127.0.0.1:${(comfy.address() as any).port}` }), host: '127.0.0.1', port: 0, agentStorePath: join(folder, 'agent.sqlite'), agentModel: '模拟模型 · 无外部调用', agentPollMs: 250 };
let step = 0;
const steps = [
  ['inspect_environment', {}],
  ['create_from_template', { checkpoint: 'v1-5-pruned-emaonly-fp16.safetensors', text: 'anime portrait' }],
  ['apply_workflow_patch', { baseVersion: 1, summary: '将画面改为竖屏，保留人物提示词', operations: [{ op: 'set_input', nodeId: '4', input: 'height', value: 768 }] }],
  ['submit_preview', { version: 2 }],
  ['save_workflow_version', { version: 2 }],
];
const model = new MockLanguageModelV3({ doGenerate: async (options) => {
  const next = steps[step++];
  return { content: options.toolChoice?.type === 'required' ? [{type:'tool-call',toolCallId:`ui-finish-${step}`,toolName:'finish_response',input:JSON.stringify({answer:'模拟流程已完成：工作流已改为竖屏，试跑结果与版本 2 已保存。这张图片是测试预览，没有调用真实模型或 GPU。'})}] : next ? [{ type: 'tool-call', toolCallId: `ui-${step}`, toolName: next[0] as string, input: JSON.stringify(next[1]) }] : [{ type: 'text', text: '模拟流程已完成：工作流已改为竖屏，试跑结果与版本 2 已保存。这张图片是测试预览，没有调用真实模型或 GPU。' }], finishReason: { unified: next ? 'tool-calls' : 'stop', raw: undefined }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } }, warnings: [] };
} });
const agent = new AgentService(config, { model });
const gateway = createGatewayServer(config, { agentService: agent });
const address = await gateway.start();
console.log(`UI_HARNESS_URL=http://127.0.0.1:${address.port}`);
const stop = async () => { await gateway.stop(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); comfy.closeAllConnections(); comfy.close(); rmSync(folder, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
