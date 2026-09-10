import { AgentHttpError } from '../store.js';
import { attachmentPath } from '../store.js';
import { canvasToPrompt, widgetLayout } from '../../workflow/canvas.js';
import type { Canvas } from '../../workflow/canvas.js';
import { WorkflowError } from '../../workflow/engine.js';
import { draftDiagnostics } from './compiler.js';
import { digest } from './digest.js';
import type { AssetService } from './assets.js';
import type { WorkspaceRepository } from './repository.js';
import type { Draft, InputManifestEntry, LibrarySaveOperation } from './types.js';

export interface LibrarySaveIntent {
  requestId: string; revision: number; mode: 'create' | 'update';
  target: LibrarySaveOperation['target']; startedBy: string;
}
const active = new Set(['pending', 'applying', 'reconciling']);
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const librarySaveSummary = (op: LibrarySaveOperation) => { const summary = { ...op }; delete summary.content; return summary; };

/** Durable fixed-version intent, verified export and read-back. Never writes a formal library file. */
export class WorkspaceLibrary {
  private flights = new Map<string, Promise<LibrarySaveOperation>>();
  constructor(readonly repo: WorkspaceRepository, readonly assets: AssetService) {}
  busy(sessionId: string) { return [...this.flights.keys()].some(id => this.repo.db.prepare('SELECT 1 FROM library_save_ops WHERE id=? AND session_id=?').get(id, sessionId)); }
  get(sessionId: string, id: string): LibrarySaveOperation {
    this.repo.session(sessionId);
    const row = this.repo.db.prepare('SELECT data FROM library_save_ops WHERE session_id=? AND id=?').get(sessionId, id);
    if (!row) throw new AgentHttpError(404, '找不到该入库操作');
    return JSON.parse(String(row.data));
  }
  current(sessionId: string): LibrarySaveOperation | null {
    this.repo.session(sessionId);
    const row = this.repo.db.prepare("SELECT data FROM library_save_ops WHERE session_id=? AND state IN ('pending','applying','reconciling') ORDER BY rowid LIMIT 1").get(sessionId);
    return row ? JSON.parse(String(row.data)) : null;
  }
  begin(sessionId: string, draftId: string, intent: LibrarySaveIntent): LibrarySaveOperation {
    return this.repo.transaction(() => {
      const version = this.repo.revision(sessionId, draftId, intent.revision);
      const requestDigest = digest({ draftId, ...intent });
      const prior = this.repo.db.prepare('SELECT session_id FROM library_save_ops WHERE id=?').get(intent.requestId);
      if (prior) {
        const op = this.get(sessionId, intent.requestId);
        if (op.requestDigest !== requestDigest) throw new AgentHttpError(409, '入库请求 ID 已用于不同参数');
        return op;
      }
      const draft = this.repo.draft(sessionId, draftId);
      if (draft.archivedAt || this.repo.session(sessionId).archivedAt) throw new AgentHttpError(409, '请先取消归档再入库');
      if (this.current(sessionId)) throw new AgentHttpError(409, '本对话已有待完成的入库操作');
      if (intent.target.serverId !== this.assets.options.serverId) throw new AgentHttpError(409, '入库目标不属于当前服务器');
      const filename = intent.target.filename;
      // eslint-disable-next-line no-control-regex -- reject filesystem control characters
      if (!filename.endsWith('.json') || filename.includes('\\') || /[\x00-\x1f]/.test(filename) || filename.split('/').some(part => !part || part === '.' || part === '..')) throw new AgentHttpError(400, '入库文件名不合法');
      if (intent.mode === 'update') {
        const source = draft.lastLibrarySave ?? draft.sourceRef;
        if (!source || source.serverId !== intent.target.serverId || source.workflowId !== intent.target.workflowId || source.filename !== filename
          || !intent.target.expectedEtag || (source.etag && source.etag !== intent.target.expectedEtag)) throw new AgentHttpError(409, '更新目标必须是该草稿已关联的工作流和版本');
      } else if (intent.target.expectedEtag) throw new AgentHttpError(400, '新建工作流不能覆盖已有版本');
      const now = Date.now();
      const op: LibrarySaveOperation = { id: intent.requestId, sessionId, draftId, revision: version.revision, revisionDigest: version.digest,
        requestDigest, mode: intent.mode, target: structuredClone(intent.target), state: 'pending', startedBy: intent.startedBy, created: now, updated: now };
      this.repo.db.prepare('INSERT INTO library_save_ops VALUES(?,?,?,?,?,?)').run(op.id, sessionId, draftId, op.revision, op.state, JSON.stringify(op));
      this.repo.store.event(sessionId, null, 'library_save_state', { operation: librarySaveSummary(op) });
      return op;
    });
  }
  private put(op: LibrarySaveOperation): LibrarySaveOperation {
    op.updated = Date.now();
    this.repo.db.prepare('UPDATE library_save_ops SET state=?,data=? WHERE id=? AND session_id=?').run(op.state, JSON.stringify(op), op.id, op.sessionId);
    this.repo.store.event(op.sessionId, null, 'library_save_state', { operation: librarySaveSummary(op) });
    return op;
  }
  private async single(sessionId: string, id: string, fn: () => Promise<LibrarySaveOperation>): Promise<LibrarySaveOperation> {
    this.get(sessionId, id); // Scope validation occurs before joining another caller's IO.
    if (this.flights.has(id)) { await this.flights.get(id)!.catch(() => undefined); return this.single(sessionId, id, fn); }
    const flight = fn(); this.flights.set(id, flight);
    try { return await flight; } finally { if (this.flights.get(id) === flight) this.flights.delete(id); }
  }
  prepare(sessionId: string, id: string, signal: AbortSignal) {
    return this.single(sessionId, id, async () => {
      let op = this.get(sessionId, id);
      if (op.state !== 'pending' || op.content) return op;
      if (op.target.serverId !== this.assets.options.serverId) throw new AgentHttpError(409, '入库目标不属于当前服务器');
      const remote = await this.assets.adapter.getWorkflow(op.target.filename, signal);
      if (op.mode === 'create' ? !!remote : !remote || remote.etag !== op.target.expectedEtag) {
        return this.repo.transaction(() => { op = this.get(sessionId, id); return op.state === 'pending' ? this.put({ ...op, state: 'conflict', result: { error: '工作流文件已变化，请另存为新工作流' } }) : op; });
      }
      const revision = this.repo.revision(sessionId, op.draftId, op.revision);
      const info = await this.assets.adapter.getObjectInfo(signal);
      const diagnostics = draftDiagnostics(revision.canvas, revision.bindings, info);
      if (diagnostics.length) throw new WorkflowError(diagnostics);
      const canvas = structuredClone(revision.canvas); const inputManifest: InputManifestEntry[] = [];
      for (const binding of revision.bindings) {
        const node = canvas.nodes.find(node => String(node.id) === binding.nodeId)!;
        const entry = await this.assets.materialize(sessionId, binding.assetId, node.type, binding.id, signal);
        node.widgets_values![widgetLayout(node)[binding.inputName]] = attachmentPath(entry.materializedRef);
        inputManifest.push(entry);
      }
      // Validate the exported ordinary workflow using the refreshed loader choices. No Run-specific output prefix.
      canvasToPrompt(canvas, await this.assets.adapter.getObjectInfo(signal));
      const previousExtra = object(object(remote?.content).extra);
      canvas.extra = { ...object(canvas.extra), ...(op.mode === 'update' ? { description: previousExtra.description, tags: previousExtra.tags } : {}),
        name: op.target.name, comfy_mobile_cloud: { schema: 2, workflow_id: op.target.workflowId, save_op_id: op.id },
        comfy_mobile_agent: { schema: 2, session_id: sessionId, draft_id: op.draftId, revision: op.revision, revision_digest: op.revisionDigest,
          server_id: op.target.serverId, inputs: inputManifest } };
      const content: Canvas = JSON.parse(JSON.stringify(canvas));
      signal.throwIfAborted();
      return this.repo.transaction(() => {
        op = this.get(sessionId, id);
        if (op.state !== 'pending' || op.content) return op;
        // Provisional pins are kept even for uncertain writes; release requires a separate verified cleanup operation.
        for (const entry of inputManifest) {
          const key = [op.target.serverId, op.target.workflowId, entry.assetId, entry.blobDigest];
          // Every historical input location remains in its save operation. This row only keeps the durable pin.
          const data = { lastOperationId: op.id, filename: op.target.filename, materializedRef: entry.materializedRef };
          this.repo.db.prepare('INSERT OR REPLACE INTO library_asset_refs VALUES(?,?,?,?,?)').run(...key, JSON.stringify(data));
        }
        return this.put({ ...op, content, inputManifest, contentDigest: digest(content), exportGraphHash: digest({ nodes: content.nodes, links: content.links }) });
      });
    });
  }
  applying(sessionId: string, id: string) {
    return this.repo.transaction(() => {
      const op = this.get(sessionId, id);
      if (!active.has(op.state) || op.state !== 'pending') return op;
      if (op.target.serverId !== this.assets.options.serverId) throw new AgentHttpError(409, '入库目标不属于当前服务器');
      if (!op.content || !op.contentDigest) throw new AgentHttpError(409, '请先准备入库内容和参考素材');
      return this.put({ ...op, state: 'applying' });
    });
  }
  cancel(sessionId: string, id: string) {
    return this.repo.transaction(() => {
      const op = this.get(sessionId, id);
      if (op.state === 'failed') return op;
      if (op.state !== 'pending') throw new AgentHttpError(409, '文件可能已提交，请先核对入库结果');
      return this.put({ ...op, state: 'failed', result: { error: '入库已取消' } });
    });
  }
  reconcile(sessionId: string, id: string, signal: AbortSignal) {
    return this.single(sessionId, id, async () => {
      let op = this.repo.transaction(() => {
        const current = this.get(sessionId, id);
        return current.state === 'applying' ? this.put({ ...current, state: 'reconciling' }) : current;
      });
      if (op.state !== 'reconciling') return op;
      if (op.target.serverId !== this.assets.options.serverId) throw new AgentHttpError(409, '入库目标不属于当前服务器');
      // A failed GET is not evidence that the file is missing. Leave the durable operation reconciling.
      const remote = await this.assets.adapter.getWorkflow(op.target.filename, signal);
      return this.repo.transaction(() => {
        op = this.get(sessionId, id);
        if (op.state !== 'reconciling') return op;
        const meta = object(object(object(remote?.content).extra).comfy_mobile_cloud);
        if (remote && meta.save_op_id === op.id && meta.workflow_id === op.target.workflowId && digest(remote.content) === op.contentDigest) {
          const next = this.put({ ...op, state: 'succeeded', result: { etag: remote.etag } });
          const draft: Draft = this.repo.draft(sessionId, op.draftId);
          draft.lastLibrarySave = { opId: op.id, draftId: op.draftId, revision: op.revision, revisionDigest: op.revisionDigest, exportGraphHash: op.exportGraphHash!,
            ...op.target, etag: remote.etag, at: next.updated };
          draft.updated = next.updated;
          this.repo.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(JSON.stringify(draft), draft.id);
          this.repo.store.event(sessionId, null, 'draft_changed', { draft });
          return next;
        }
        if (remote && (op.mode === 'create' || remote.etag !== op.target.expectedEtag)) return this.put({ ...op, state: 'conflict', result: { error: '工作流文件已变化，请另存为新工作流' } });
        // Missing/unchanged can race an in-flight POST. The same original conditional write can be retried safely.
        return this.put({ ...op, result: { error: '尚未确认入库，可核对或重试原保存' } });
      });
    });
  }
}
