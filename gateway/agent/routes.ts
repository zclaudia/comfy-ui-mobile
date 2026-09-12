import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { modelInput } from './models.js';
import { AgentHttpError } from './store.js';
import { WorkflowError } from '../workflow/engine.js';
import type { AgentService } from './service.js';
import { handleWorkspaceRequest } from './workspace/routes.js';

const id = z.string().uuid();
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
    return await handleWorkspaceRequest(service, owner, request, response, url, readBody, send);
    throw new AgentHttpError(404, '接口不存在');
  } catch (error) {
    if (error instanceof z.ZodError) return send(400, { error: '参数格式不正确', issues: error.issues });
    if (error instanceof WorkflowError) return send(422, { error: '工作流暂不支持或存在错误', diagnostics: error.diagnostics });
    if (error instanceof AgentHttpError) return send(error.status, { error: error.message });
    send(500, { error: 'Agent 服务内部错误' });
  }
}
