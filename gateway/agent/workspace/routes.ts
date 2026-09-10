import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { AgentService } from '../service.js';
import { AgentHttpError, activeStates } from '../store.js';
import type { Task } from '../store.js';
import type { Canvas } from '../../workflow/canvas.js';
import { runSummary } from './types.js';
import type { Asset, Draft, Revision, WorkspaceSession } from './types.js';
import { librarySaveSummary } from './library.js';
import { legacyTranscriptEvents, legacyVersion } from './legacy.js';

const id = z.string().uuid();
const revision = z.number().int().positive();
const name = z.string().trim().min(1).max(100);
const sourceRef = z.object({ serverId: z.string().min(1).max(300), workflowId: z.string().min(1).max(200), filename: z.string().min(1).max(300), name, etag: z.string().max(200).optional() }).strict();
const pageSchema = z.object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const kind = z.enum(['image', 'video', 'audio', 'file']);
const canvas = z.object({ version: z.literal(0.4), nodes: z.array(z.object({ id: z.number().int().nonnegative(), type: z.string().max(200) }).passthrough()).max(100), links: z.array(z.array(z.unknown())).max(500) }).passthrough();
const bindings = z.array(z.object({ id: z.string().min(1).max(100), nodeId: z.string().min(1).max(100), inputName: z.string().min(1).max(100), role: z.string().min(1).max(100), assetId: id }).strict()).max(8);
const reference = z.object({ nodeId: z.string().min(1).max(100), inputName: z.string().min(1).max(100), assetId: id.nullable() }).strict();
const contextSchema = z.object({ targetDraftId: id.optional(), sourceRevision: revision.optional(), selectedAssetIds: z.array(id).max(8).optional(), replyToEventSeq: z.number().int().positive().optional(), action: z.enum(['edit_source', 'use_reference', 'generate_video', 'rerun', 'fork']).optional() }).strict();
const template = z.object({ templateId: z.string().min(1).max(100), text: z.string().max(8000), checkpoint: z.string().max(500).optional(), width: revision.optional(), height: revision.optional(), frames: revision.optional(), seed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(), modelVariant: z.enum(['q5', 'q6']).optional(), filenamePrefix: z.string().max(300).optional(), references: z.array(reference).max(8).optional() }).strict();
const mediaRef = z.object({ filename: z.string().trim().min(1).max(300), subfolder: z.string().max(300).default(''), type: z.enum(['input', 'temp']).default('input'), kind, name: z.string().max(300).optional(), size: z.number().int().nonnegative().optional(), width: revision.optional(), height: revision.optional() }).strict();
type Send = (status: number, body: unknown) => void;

/** V2 requests are deliberately separate from session-global version writes. Authentication is supplied by the gateway. */
export async function handleWorkspaceRequest(service: AgentService, owner: string, request: IncomingMessage, response: ServerResponse, url: URL, readRequestBody: (request: IncomingMessage) => Promise<unknown>, send: Send) {
  const runtime = service.workspace!; const repo = runtime.repository;
  const expectedServerId = request.headers['x-agent-server-id'];
  if (expectedServerId !== undefined && expectedServerId !== encodeURIComponent(runtime.assets.options.serverId)) throw new AgentHttpError(409, '服务器身份已变化，本机草稿保持离线');
  const draftSummary = (draft: Draft) => { const latest = repo.runs(draft.sessionId, { draftId: draft.id, limit: 1 }).items[0]; return { ...draft, ...(latest ? { latestRun: runSummary(latest) } : {}) }; };
  const path = url.pathname.slice('/api/gateway/agent'.length);
  const parts = path.split('/').filter(Boolean); const method = request.method;
  // Official previews carry the immutable asset token without a session path.
  // Resolve only within the authenticated owner's workspace, then use exactly
  // the same availability, digest and range checks as the session media route.
  if (method === 'GET' && parts.length === 3 && parts[0] === 'assets' && parts[2] === 'content' && id.safeParse(parts[1]).success) {
    const assetId = parts[1];
    const row = repo.db.prepare('SELECT a.session_id FROM assets a JOIN sessions s ON s.id=a.session_id WHERE a.id=? AND s.owner=?').get(assetId, owner);
    if (!row) throw new AgentHttpError(404, '素材不存在');
    parts.splice(0, parts.length, 'sessions', String(row.session_id), 'assets', assetId, 'content');
  }
  const readBody = async (incoming: IncomingMessage) => {
    const body = await readRequestBody(incoming);
    // Cleanup can commit while a slow client is still sending its request body.
    if (parts[0] === 'sessions' && id.safeParse(parts[1]).success && !(parts.length === 3 && parts[2] === 'cleanup') && repo.session(parts[1], owner).deletedAt) {
      throw new AgentHttpError(410, '此会话已清理，仅保留入库依赖的来源记录');
    }
    return body;
  };
  if (method !== 'GET' && request.headers['x-agent-schema-version'] !== '2') throw new AgentHttpError(426, '请升级客户端后再修改多工作流会话');
  const page = () => pageSchema.parse(Object.fromEntries(['before', 'limit'].flatMap(key => url.searchParams.has(key) ? [[key, url.searchParams.get(key)]] : [])));
  if (parts.length === 1 && parts[0] === 'sessions') {
    if (method === 'POST') {
      const body = z.object({ name: name.default('新对话') }).strict().parse(await readBody(request));
      return send(201, { session: await service.createSession(owner, body.name) });
    }
    if (method === 'GET') {
      const { before = Number.MAX_SAFE_INTEGER, limit } = page();
      const search = z.string().max(200).parse(url.searchParams.get('search') ?? '').trim();
      const archived = url.searchParams.get('archived') === 'true';
      const rows = repo.db.prepare(`SELECT s.rowid AS ordinal,w.data,
        (SELECT MAX(e.created) FROM events e WHERE e.session_id=s.id) AS last_activity,
        (SELECT json_extract(e.data,'$.text') FROM events e WHERE e.session_id=s.id AND e.kind='user' ORDER BY seq DESC LIMIT 1) AS last_message,
        (SELECT json_extract(e.data,'$.text') FROM events e WHERE e.session_id=s.id AND e.kind='user' ORDER BY seq ASC LIMIT 1) AS preview,
        (SELECT state FROM tasks t WHERE t.session_id=s.id ORDER BY rowid DESC LIMIT 1) AS last_state,
        (SELECT id FROM assets a WHERE a.session_id=s.id AND kind IN ('image','video') ORDER BY ordinal DESC LIMIT 1) AS thumbnail_asset_id
        FROM sessions s JOIN workspace_sessions w ON w.id=s.id WHERE s.owner=? AND s.rowid<? AND json_extract(w.data,'$.archivedAt') IS ${archived ? 'NOT NULL' : 'NULL'}
        AND (json_extract(w.data,'$.deletedAt') IS NULL OR EXISTS(SELECT 1 FROM workspace_cleanup_ops c WHERE c.session_id=s.id AND json_extract(c.data,'$.state')<>'completed'))
        AND (?='' OR instr(lower(json_extract(w.data,'$.name')),lower(?))>0 OR EXISTS(SELECT 1 FROM events e WHERE e.session_id=s.id AND e.kind='user' AND instr(lower(json_extract(e.data,'$.text')),lower(?))>0))
        ORDER BY s.rowid DESC LIMIT ?`).all(owner, before, search, search, search, limit + 1);
      return send(200, { items: rows.slice(0, limit).map(row => { const session = JSON.parse(String(row.data)) as WorkspaceSession; return { ...session, lastActivity: row.last_activity ?? session.created, lastMessage: row.last_message, preview: row.preview, lastState: row.last_state, thumbnailAssetId: row.thumbnail_asset_id, active: activeStates.includes(row.last_state as Task['state']) }; }), ...(rows.length > limit ? { nextCursor: Number(rows[limit - 1].ordinal) } : {}) });
    }
  }
  if (parts[0] !== 'sessions' || !id.safeParse(parts[1]).success) throw new AgentHttpError(404, '接口不存在');
  const sessionId = parts[1]; const session = repo.session(sessionId, owner);
  const signal = AbortSignal.timeout(service.config.agentStepTimeoutMs ?? 90_000);
  if (parts.length === 3 && parts[2] === 'cleanup') {
    if (method === 'GET') return send(200, await runtime.cleanup.preview(sessionId));
    if (method === 'POST') {
      const body = z.object({ requestId: id, planToken: z.string().regex(/^[0-9a-f]{64}$/), confirm: z.literal('delete-chat') }).strict().parse(await readBody(request));
      return send(200, { operation: await runtime.cleanup.execute(sessionId, body.requestId, body.planToken) });
    }
  }
  if (session.deletedAt && (method !== 'GET' || parts.length === 2)) throw new AgentHttpError(410, '此会话已清理，仅保留入库依赖的来源记录');
  if (parts[2] === 'library-saves') {
    if (parts.length === 3 && method === 'GET') { const operation = runtime.library.current(sessionId); return send(200, { operation: operation ? librarySaveSummary(operation) : null }); }
    const operationId = id.parse(parts[3]);
    if (parts.length === 4 && method === 'GET') return send(200, { operation: runtime.library.get(sessionId, operationId) });
    if (parts.length === 5 && method === 'POST') {
      z.object({}).strict().parse(await readBody(request));
      if (parts[4] === 'prepare') return send(200, { operation: await runtime.library.prepare(sessionId, operationId, signal) });
      if (parts[4] === 'applying') return send(200, { operation: runtime.library.applying(sessionId, operationId) });
      if (parts[4] === 'reconcile') return send(200, { operation: await runtime.library.reconcile(sessionId, operationId, signal) });
      if (parts[4] === 'cancel') return send(200, { operation: runtime.library.cancel(sessionId, operationId) });
    }
    throw new AgentHttpError(404, '接口不存在');
  }
  if (parts.length === 2) {
    if (method === 'GET') {
      const after = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(url.searchParams.get('after') ?? 0);
      return send(200, repo.transaction(() => {
        const highWater = Number(repo.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE session_id=?').get(sessionId)!.seq);
        const events = legacyTranscriptEvents(repo, sessionId, service.store.events(sessionId, after).filter(event => event.seq <= highWater));
        const tasks = service.store.tasks(sessionId).slice(0, 20).map(task => { const result: Partial<Task> = { ...task }; delete result.messages; return result; });
        const cursor = events.at(-1)?.seq ?? after;
        const questions = tasks.flatMap(task => task.workspace?.waitingReason?.type === 'selection' ? [runtime.selections.get(sessionId, task.workspace.waitingReason.questionId)] : []);
        const runs = repo.runs(sessionId, { limit: 10 });
        const drafts = repo.drafts(sessionId, { limit: 20 });
        return { session: repo.session(sessionId), drafts: { ...drafts, items: drafts.items.map(draftSummary) }, runs: { ...runs, items: runs.items.map(runSummary) }, tasks, questions, events, cursor, highWater, hasMore: cursor < highWater };
      }));
    }
    if (method === 'PATCH') {
      const body = z.object({ name: name.optional(), previewPolicy: z.enum(['auto', 'confirm']).optional(), archivedAt: z.number().int().nonnegative().nullable().optional() }).strict().parse(await readBody(request));
      if (body.archivedAt != null && service.store.tasks().some(task => task.sessionId === sessionId)) throw new AgentHttpError(409, '请先停止当前任务再归档');
      return send(200, { session: repo.updateSession(sessionId, body) });
    }
    if (method === 'DELETE') throw new AgentHttpError(409, '请先归档会话；永久清理需要检查素材和已入库工作流引用');
  }
  if (parts.length === 3 && parts[2] === 'messages' && method === 'POST') {
    const body = z.object({ requestId: id, message: z.string().trim().max(8000).default(''), context: contextSchema.optional(), assetIds: z.array(id).max(8).optional() }).strict().parse(await readBody(request));
    const context = { ...body.context };
    if (body.assetIds) context.selectedAssetIds = [...new Set([...(context.selectedAssetIds ?? []), ...body.assetIds])];
    if ((context.selectedAssetIds?.length ?? 0) > 8) throw new AgentHttpError(422, '本轮参考素材不能超过 8 个');
    if (!body.message && !context.action) throw new AgentHttpError(400, '请描述用途或选择具体操作');
    const task = service.enqueue(sessionId, owner, body.requestId, body.message, [], context);
    return send(202, { taskId: task.id, state: task.state });
  }
  if (parts.length === 3 && parts[2] === 'cancel' && method === 'POST') {
    const body = z.object({ taskId: id }).strict().parse(await readBody(request));
    return send(200, service.cancel(sessionId, owner, body.taskId));
  }
  if (parts.length === 3 && parts[2] === 'approve' && method === 'POST') {
    const body = z.object({ taskId: id, runId: id, approvalDigest: z.string().regex(/^[0-9a-f]{64}$/), approved: z.boolean() }).strict().parse(await readBody(request));
    return send(200, { run: runtime.approve(sessionId, body.taskId, body.runId, body.approvalDigest, body.approved) });
  }
  if (parts.length === 5 && parts[2] === 'selections' && parts[4] === 'answer' && method === 'POST') {
    const body = z.object({ taskId: id, selectedIndices: z.array(z.number().int().nonnegative()).max(12), answer: z.string().max(4000).optional() }).strict().parse(await readBody(request));
    return send(200, { selection: runtime.selections.answer(sessionId, body.taskId, id.parse(parts[3]), body) });
  }
  if (parts[2] === 'drafts') {
    if (parts.length === 3 && method === 'GET') { const drafts = repo.drafts(sessionId, { ...page(), archived: url.searchParams.get('archived') === 'true', ...(url.searchParams.has('kind') ? { kind: kind.parse(url.searchParams.get('kind')) } : {}), ...(url.searchParams.has('name') ? { name: name.parse(url.searchParams.get('name')) } : {}) }); return send(200, { ...drafts, items: drafts.items.map(draftSummary) }); }
    if (parts.length === 3 && method === 'POST') {
      const body = z.discriminatedUnion('source', [
        z.object({ source: z.literal('template'), requestId: id, name, template }).strict(),
        z.object({ source: z.literal('canvas'), requestId: id, name, canvas, bindings: bindings.default([]), sourceRef: sourceRef.optional() }).strict(),
      ]).parse(await readBody(request));
      const info = await service.adapter.getObjectInfo(signal);
      return send(201, body.source === 'template' ? runtime.workflows.create(sessionId, { ...body.template, name: body.name }, { requestId: body.requestId }, info)
        : runtime.workflows.importCanvas(sessionId, { name: body.name, canvas: body.canvas as Canvas, bindings: body.bindings, ...(body.sourceRef ? { sourceRef: body.sourceRef } : {}) }, { requestId: body.requestId }, info));
    }
    const draftId = id.parse(parts[3]); repo.draft(sessionId, draftId);
    if (parts.length === 5 && parts[4] === 'discard-local' && method === 'POST') {
      // Cancellation never executes this graph. Keep invalid editor documents cancelable too (e.g. a prior 400).
      const localContent = { canvas: z.record(z.unknown()), bindings: z.array(z.unknown()) };
      const body = z.object({
        pending: z.object({ requestId: id, expectedHeadRevision: revision, sourceRevision: revision, ...localContent, summary: z.string().trim() }).strict().optional(),
        fork: z.object({ requestId: id, sourceRevision: revision, name: z.string().trim(), ...localContent }).strict().optional(),
      }).strict().parse(await readBody(request));
      return send(200, repo.transaction(() => {
        // Match the exact command envelopes used by saveCanvas/forkCanvas, including requestId.
        const saved = body.pending && repo.cancelLocalRequest<{ revision: Revision }>(sessionId, body.pending.requestId, 'edit_workflow', { ...body.pending, draftId });
        const forked = body.fork && repo.cancelLocalRequest<{ revision: Revision }>(sessionId, body.fork.requestId, 'fork_workflow', { local: true, ...body.fork, draftId });
        return { revision: repo.revision(sessionId, draftId),
          ...(saved ? { savedRevision: saved.revision.revision } : {}),
          ...(forked ? { forkedTo: { draftId: forked.revision.draftId, revision: forked.revision.revision } } : {}) };
      }));
    }
    if (parts.length === 4 && method === 'GET') return send(200, { draft: draftSummary(repo.draft(sessionId, draftId)) });
    if (parts.length === 5 && parts[4] === 'library-saves' && method === 'POST') {
      const body = z.object({ requestId: id, revision, mode: z.enum(['create', 'update']), startedBy: z.string().trim().min(1).max(200),
        target: z.object({ serverId: z.string().min(1).max(300), workflowId: z.string().min(1).max(200), filename: z.string().min(1).max(300), name, expectedEtag: z.string().min(1).max(200).optional() }).strict() }).strict().parse(await readBody(request));
      return send(201, { operation: runtime.library.begin(sessionId, draftId, body) });
    }
    if (parts.length === 4 && method === 'PATCH') {
      const patch = z.object({ name: name.optional(), archivedAt: z.number().int().nonnegative().nullable().optional() }).strict().parse(await readBody(request));
      return send(200, { draft: repo.updateDraft(sessionId, draftId, patch) });
    }
    if (parts.length === 5 && parts[4] === 'versions') {
      if (method === 'GET') return send(200, repo.revisions(sessionId, draftId, page()));
      if (method === 'POST') {
        const body = z.object({ requestId: id, expectedHeadRevision: revision, sourceRevision: revision, canvas, bindings, summary: z.string().trim().min(1).max(300) }).strict().parse(await readBody(request));
        const info = await service.adapter.getObjectInfo(signal);
        return send(201, runtime.workflows.saveCanvas(sessionId, { ...body, draftId, canvas: body.canvas as Canvas }, { requestId: body.requestId }, info));
      }
    }
    if (parts.length === 6 && parts[4] === 'versions' && method === 'GET') return send(200, repo.revision(sessionId, draftId, revision.parse(Number(parts[5]))));
    if (parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
      const body = z.object({ requestId: id, sourceRevision: revision, expectedHeadRevision: revision }).strict().parse(await readBody(request));
      return send(201, { revision: repo.restore(sessionId, draftId, body.sourceRevision, body.expectedHeadRevision, { requestId: body.requestId }) });
    }
    if (parts.length === 5 && parts[4] === 'fork' && method === 'POST') {
      const body = z.object({ requestId: id, sourceRevision: revision, name }).strict().parse(await readBody(request));
      return send(201, repo.fork(sessionId, draftId, body.sourceRevision, body.name, { requestId: body.requestId }));
    }
    if (parts.length === 5 && parts[4] === 'fork-local' && method === 'POST') {
      const body = z.object({ requestId: id, sourceRevision: revision, name, canvas, bindings }).strict().parse(await readBody(request));
      const info = await service.adapter.getObjectInfo(signal);
      return send(201, runtime.workflows.forkCanvas(sessionId, { ...body, draftId, canvas: body.canvas as Canvas }, { requestId: body.requestId }, info));
    }
  }
  if (parts[2] === 'assets') {
    if (parts.length === 3 && method === 'GET') return send(200, repo.assets(sessionId, { ...page(), ...(url.searchParams.has('kind') ? { kind: kind.parse(url.searchParams.get('kind')) } : {}), ...(url.searchParams.has('runId') ? { runId: id.parse(url.searchParams.get('runId')) } : {}), ...(url.searchParams.has('draftId') ? { draftId: id.parse(url.searchParams.get('draftId')) } : {}) }));
    if (parts.length === 3 && method === 'POST') {
      const body = z.object({ requestId: id, file: mediaRef, sourceMessageSeq: revision.optional() }).strict().parse(await readBody(request));
      return send(201, { asset: runtime.assets.registerUpload(sessionId, body.file, body.requestId, body.sourceMessageSeq) });
    }
    const assetId = id.parse(parts[3]); const asset = repo.asset(sessionId, assetId);
    if (parts.length === 5 && parts[4] === 'library-uses' && method === 'GET') {
      const { before = Number.MAX_SAFE_INTEGER, limit } = page();
      const rows = repo.db.prepare("SELECT rowid AS ordinal,id FROM library_save_ops WHERE session_id=? AND rowid<? AND EXISTS(SELECT 1 FROM json_each(library_save_ops.data,'$.inputManifest') WHERE json_extract(value,'$.assetId')=?) ORDER BY rowid DESC LIMIT ?").all(sessionId, before, assetId, limit + 1);
      return send(200, { items: rows.slice(0, limit).map(row => { const op = runtime.library.get(sessionId, String(row.id)); return { id: op.id, serverId: op.target.serverId, workflowId: op.target.workflowId,
        saves: [{ operationId: op.id, filename: op.target.filename, name: op.target.name, revision: op.revision, state: op.state }] }; }),
      ...(rows.length > limit ? { nextCursor: Number(rows[limit - 1].ordinal) } : {}) });
    }
    if (parts.length === 5 && parts[4] === 'uses' && method === 'GET') { const pagination = page(); return send(200, repo.assetUses(sessionId, assetId, pagination.before, pagination.limit)); }
    if (parts.length === 4 && method === 'GET') {
      const location = repo.locations(sessionId, assetId).find(location => location.role === 'source' && location.serverId === runtime.assets.options.serverId);
      return send(200, { asset, sourceRun: asset.sourceRunId ? runSummary(repo.run(sessionId, asset.sourceRunId)) : null,
        ...(location ? { previewRef: { ...location.ref, serverId: location.serverId } } : {}) });
    }
    if (parts.length === 5 && parts[4] === 'content' && method === 'GET') {
      const file = await runtime.assets.read(sessionId, assetId);
      return sendMedia(response, request, file.asset, file.bytes, file.mediaType);
    }
  }
  if (parts.length === 3 && parts[2] === 'runs' && method === 'POST') {
    const body = z.object({ requestId: id, draftId: id, revision }).strict().parse(await readBody(request));
    const task = service.enqueueWorkspaceRun(sessionId, owner, body.requestId, body.draftId, body.revision);
    return send(202, { taskId: task.id, state: task.state, runId: task.workspace?.activeRunId ?? (task.result as { id?: string } | undefined)?.id });
  }
  if (parts[2] === 'runs' && method === 'GET') {
    if (parts.length === 5 && parts[4] === 'assets') return send(200, repo.runAssets(sessionId, id.parse(parts[3]), z.coerce.number().int().nonnegative().parse(url.searchParams.get('after') ?? 0), page().limit));
    if (parts.length === 3) { const result = repo.runs(sessionId, { ...page(), ...(url.searchParams.has('draftId') ? { draftId: id.parse(url.searchParams.get('draftId')) } : {}) }); return send(200, { ...result, items: result.items.map(runSummary) }); }
    if (parts.length === 4) { const run = repo.run(sessionId, id.parse(parts[3])); return send(200, { run: { ...run, ...runSummary(run), outputAssetIds: run.outputAssetIds } }); }
  }
  if (parts.length === 4 && parts[2] === 'versions' && method === 'GET') return send(200, legacyVersion(repo, sessionId, revision.parse(Number(parts[3]))));
  if (parts[2] === 'versions' || parts[2] === 'restore' || parts[2] === 'save') throw new AgentHttpError(426, '请升级客户端并指定具体草稿；会话不再拥有全局工作流版本');
  throw new AgentHttpError(404, '接口不存在');
}

/** Authenticated range responses support video seeking without public file URLs. */
function sendMedia(response: ServerResponse, request: IncomingMessage, asset: Asset, bytes: Uint8Array, mediaType: string) {
  const headers = { 'Content-Type': mediaType, 'Cache-Control': 'private, no-cache', 'Accept-Ranges': 'bytes', 'ETag': `"${asset.blobDigest}"`, 'X-Content-Type-Options': 'nosniff' };
  if (request.headers['if-none-match'] === headers.ETag && !request.headers.range) { response.writeHead(304, headers); response.end(); return; }
  const range = request.headers.range;
  if (range && (!request.headers['if-range'] || request.headers['if-range'] === headers.ETag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, bytes.length - Number(match[2])) : NaN;
    const end = match?.[1] && match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes.length) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` }); response.end(); return; }
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
    response.end(bytes.subarray(start, end + 1)); return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': bytes.length }); response.end(bytes);
}
