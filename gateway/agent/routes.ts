import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { modelInput } from './models.js';
import { AgentHttpError } from './store.js';
import { WorkflowError } from '../workflow/engine.js';
import type { AgentService } from './service.js';
import type { Canvas } from '../workflow/canvas.js';

const id = z.string().uuid();
const version = z.number().int().positive();
const canvasInput = z.object({ version: z.literal(0.4), nodes: z.array(z.object({ id: z.number().int().nonnegative(), type: z.string(), widgets_values: z.array(z.unknown()).optional(), inputs: z.array(z.object({ name: z.string(), link: z.number().nullable().optional() }).passthrough()).optional(), outputs: z.array(z.object({ links: z.array(z.number()).nullable().optional() }).passthrough()).optional() }).passthrough()).max(100), links: z.array(z.array(z.unknown())).max(500) }).passthrough();
const workflowInput = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().min(1).max(100), filename: z.string().trim().min(1).max(300).optional() }).strict();
const createInput = z.object({ name: z.string().trim().min(1).max(100).default('新工作流'), canvas: canvasInput.optional(), workflow: workflowInput.optional() }).strict();
const patchInput = z.object({ name: z.string().trim().min(1).max(100).optional(), workflow: workflowInput.nullable().optional(), previewPolicy: z.enum(['auto', 'confirm']).optional() }).strict();
const approveInput = z.object({ taskId: id, callId: z.string().trim().min(1).max(200), approved: z.boolean() }).strict();
const importInput = z.object({ canvas: canvasInput, baseVersion: z.number().int().nonnegative(), summary: z.string().trim().min(1).max(200).default('画布修改') }).strict();
const filename = z.string().trim().min(1).max(300).refine(v => !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..', '文件名不合法');
const subfolder = z.string().trim().max(300).refine(v => !v.split(/[\\/]/).some(part => part === '..'), '子目录不合法').default('');
const attachmentInput = z.object({ filename, subfolder, type: z.enum(['input', 'temp']).default('input'), kind: z.enum(['image', 'video', 'audio', 'file']), name: z.string().trim().max(300).optional(), size: z.number().int().nonnegative().optional(), width: z.number().int().positive().max(65535).optional(), height: z.number().int().positive().max(65535).optional() }).strict()
  .refine(a => (a.width === undefined) === (a.height === undefined), { message: '宽高需同时提供', path: ['height'] });
const messageInput = z.object({ requestId: id, message: z.string().trim().max(8000).default(''), attachments: z.array(attachmentInput).max(8).default([]) }).strict()
  .refine(body => body.message.length > 0 || body.attachments.length > 0, { message: '消息不能为空', path: ['message'] });

async function readBody(request: IncomingMessage): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > 512 * 1024) throw new AgentHttpError(413, '请求过大');
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new AgentHttpError(400, '无效 JSON'); }
}
export async function handleAgentRequest(service: AgentService, owner: string, request: IncomingMessage, response: ServerResponse, url: URL) {
  const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
  try {
    const path = url.pathname.slice('/api/gateway/agent'.length);
    const method = request.method;
    if (path === '/status' && method === 'GET') return send(200, service.status());
    if (path === '/models' && method === 'GET') return send(200, service.models.list());
    if (path === '/models' && method === 'POST') return send(201, { model: service.models.save(modelInput.parse(await readBody(request))) });
    const modelPath = /^\/models\/([^/]+)(\/activate)?$/.exec(path);
    if (modelPath && id.safeParse(modelPath[1]).success) {
      if (modelPath[2] && method === 'POST') return send(200, service.models.activate(modelPath[1]));
      if (!modelPath[2] && method === 'PUT') return send(200, { model: service.models.save(modelInput.parse(await readBody(request)), modelPath[1]) });
      if (!modelPath[2] && method === 'DELETE') return send(200, service.models.remove(modelPath[1]));
    }
    if (path === '/sessions' && method === 'GET') return send(200, { sessions: service.store.list(owner) });
    if (path === '/sessions' && method === 'POST') {
      const body = createInput.parse(await readBody(request));
      return send(201, { session: await service.createSession(owner, body.name, body.canvas as Canvas | undefined, body.workflow) });
    }
    const parts = path.split('/').filter(Boolean);
    if (parts[0] !== 'sessions' || !id.safeParse(parts[1]).success) throw new AgentHttpError(404, '接口不存在');
    const sessionId = parts[1];
    service.store.session(sessionId, owner);
    if (parts.length === 2 && method === 'GET') {
      const after = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? 0);
      return send(200, service.snapshot(sessionId, owner, after));
    }
    if (parts.length === 2 && method === 'PATCH') {
      const body = patchInput.parse(await readBody(request));
      return send(200, { session: service.updateSession(sessionId, owner, body) });
    }
    if (parts.length === 2 && method === 'DELETE') return send(200, service.deleteSession(sessionId, owner));
    if (parts.length === 3 && parts[2] === 'versions' && method === 'POST') {
      const body = importInput.parse(await readBody(request));
      return send(200, service.importVersion(sessionId, owner, body.canvas as Canvas, body.baseVersion, body.summary));
    }
    if (parts.length === 3 && parts[2] === 'messages' && method === 'POST') {
      const body = messageInput.parse(await readBody(request));
      const task = service.enqueue(sessionId, owner, body.requestId, body.message, body.attachments);
      return send(202, { taskId: task.id, state: task.state });
    }
    if (parts.length === 3 && parts[2] === 'approve' && method === 'POST') {
      const body = approveInput.parse(await readBody(request));
      return send(200, service.approve(sessionId, owner, body.taskId, body.callId, body.approved));
    }
    if (parts.length === 3 && parts[2] === 'cancel' && method === 'POST') {
      const body = z.object({ taskId: id }).strict().parse(await readBody(request));
      return send(200, service.cancel(sessionId, owner, body.taskId));
    }
    if (parts.length === 3 && parts[2] === 'restore' && method === 'POST') {
      const body = z.object({ version, baseVersion: z.number().int().nonnegative() }).strict().parse(await readBody(request));
      return send(200, service.restore(sessionId, owner, body.version, body.baseVersion));
    }
    if (parts.length === 4 && parts[2] === 'versions' && method === 'GET') {
      const data = service.store.version(sessionId, z.coerce.number().int().positive().parse(parts[3]));
      if (!data) throw new AgentHttpError(404, '版本不存在');
      return send(200, data);
    }
    if (parts.length === 3 && parts[2] === 'save' && method === 'POST') {
      const body = z.object({ version }).strict().parse(await readBody(request));
      service.store.transaction(() => { service.store.saveVersion(sessionId, body.version); service.store.event(sessionId, null, 'saved', body); });
      return send(200, { saved: true });
    }
    throw new AgentHttpError(404, '接口不存在');
  } catch (error) {
    if (error instanceof z.ZodError) return send(400, { error: '参数格式不正确', issues: error.issues });
    if (error instanceof WorkflowError) return send(422, { error: '工作流暂不支持或存在错误', diagnostics: error.diagnostics });
    if (error instanceof AgentHttpError) return send(error.status, { error: error.message });
    send(500, { error: 'Agent 服务内部错误' });
  }
}
