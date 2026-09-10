import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { AgentStore, AgentHttpError, activeStates } from '../store.js';
import type { SourceRef } from '../store.js';
import type { Canvas } from '../../workflow/canvas.js';
import { createWorkspaceSchema } from './schema.js';
import { canonicalJson, digest } from './digest.js';
import { runSummary } from './types.js';
import type { Asset, AssetBinding, AssetLocation, Draft, Materialization, MediaKind, Operation, OperationKind, OperationPlan, Page, RequestContext, Revision, RevisionRef, Run, RunState, WorkspaceSession } from './types.js';

export type WriteIdentity = { requestId: string; operationId?: never; taskId?: never } | { operationId: string; taskId: string; requestId?: never };
export interface DraftInput { name: string; canvas: Canvas; bindings?: AssetBinding[]; outputKinds: MediaKind[]; summary?: string; sourceRef?: SourceRef; forkedFrom?: RevisionRef }
export interface RevisionInput { expectedHeadRevision: number; sourceRevision: number; canvas: Canvas; bindings: AssetBinding[]; summary: string }
type Row = { data: string; ordinal?: number };
const decode = <T>(row: Row): T => JSON.parse(row.data) as T;
const json = (value: unknown) => JSON.stringify(value);
const exists = <T>(row: Row | undefined, message: string): T => {
  if (!row) throw new AgentHttpError(404, message);
  return decode<T>(row);
};
const limitOf = (limit = 50) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AgentHttpError(400, '分页数量必须为 1 到 200');
  return limit;
};
const beforeOf = (before = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(before) || before < 1) throw new AgentHttpError(400, '分页游标不合法');
  return before;
};

/** Explicit object identities. No operation uses a session-global "current workflow". */
export class WorkspaceRepository {
  private depth = 0;
  readonly db: AgentStore['db'];
  constructor(readonly store: AgentStore) {
    this.db = store.db;
    createWorkspaceSchema(this.db);
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    return this.store.transaction(() => {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    });
  }
  initializeSession(id: string): WorkspaceSession {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM workspace_sessions WHERE id=?').get(id) as Row | undefined;
      if (existing) return decode<WorkspaceSession>(existing);
      const old = this.store.session(id);
      const session: WorkspaceSession = { id, owner: old.owner, name: old.name, created: old.created, schemaVersion: 2,
        ...(old.previewPolicy ? { previewPolicy: old.previewPolicy } : {}) };
      this.db.prepare('INSERT INTO workspace_sessions VALUES(?,?)').run(id, json(session));
      return session;
    });
  }
  createSession(owner: string, name: string): WorkspaceSession {
    return this.transaction(() => {
      const session = { id: randomUUID(), owner, name, version: 0, created: Date.now(), workspaceMode: 'draft' };
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session.id, owner, json(session));
      return this.initializeSession(session.id);
    });
  }
  session(id: string, owner?: string): WorkspaceSession {
    this.store.session(id, owner);
    return exists(this.db.prepare('SELECT data FROM workspace_sessions WHERE id=?').get(id) as Row | undefined, '会话尚未迁移到多工作流版本');
  }
  updateSession(sessionId: string, patch: Partial<Pick<WorkspaceSession, 'name' | 'previewPolicy'>> & { archivedAt?: number | null }): WorkspaceSession {
    return this.transaction(() => {
      const current = this.session(sessionId);
      if (current.deletedAt) throw new AgentHttpError(410, '此会话已清理，仅保留入库依赖的来源记录');
      const next: WorkspaceSession = { ...current, ...patch, archivedAt: patch.archivedAt === null ? undefined : patch.archivedAt ?? current.archivedAt };
      this.db.prepare('UPDATE workspace_sessions SET data=? WHERE id=?').run(json(next), sessionId);
      const legacy = this.store.session(sessionId);
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(json({ ...legacy, name: next.name, previewPolicy: next.previewPolicy }), sessionId);
      return next;
    });
  }
  setDefaultContext(sessionId: string, context: RequestContext) {
    return this.transaction(() => {
      const session = this.session(sessionId);
      this.validateContext(sessionId, context);
      session.defaultContext = structuredClone(context);
      this.db.prepare('UPDATE workspace_sessions SET data=? WHERE id=?').run(json(session), sessionId);
    });
  }
  validateContext(sessionId: string, context: RequestContext) {
    this.session(sessionId);
    if (context.sourceRevision !== undefined && !context.targetDraftId) throw new AgentHttpError(400, '历史版本需要指定所属创作');
    if (context.targetDraftId) {
      this.draft(sessionId, context.targetDraftId);
      if (context.sourceRevision !== undefined) this.revision(sessionId, context.targetDraftId, context.sourceRevision);
    }
    for (const id of context.selectedAssetIds ?? []) this.asset(sessionId, id);
    if (context.replyToEventSeq !== undefined && !this.db.prepare('SELECT seq FROM events WHERE session_id=? AND seq=?').get(sessionId, context.replyToEventSeq)) throw new AgentHttpError(404, '引用的消息不在本对话中');
  }
  draft(sessionId: string, id: string): Draft {
    return exists(this.db.prepare('SELECT data FROM drafts WHERE session_id=? AND id=?').get(sessionId, id) as Row | undefined, '本对话中找不到该创作');
  }
  updateDraft(sessionId: string, id: string, patch: { name?: string; archivedAt?: number | null }): Draft {
    return this.transaction(() => {
      this.assertWriter(sessionId);
      const current = this.draft(sessionId, id);
      const next: Draft = { ...current, ...(patch.name !== undefined ? { name: patch.name } : {}), updated: Date.now() };
      if (patch.archivedAt !== undefined) next.archivedAt = patch.archivedAt ?? undefined;
      this.db.prepare('UPDATE drafts SET data=? WHERE id=?').run(json(next), id);
      this.store.event(sessionId, null, 'draft_changed', { draft: next });
      return next;
    });
  }
  revision(sessionId: string, draftId: string, revision?: number): Revision {
    const draft = this.draft(sessionId, draftId);
    return exists(this.db.prepare('SELECT data FROM draft_revisions WHERE session_id=? AND draft_id=? AND revision=?').get(sessionId, draftId, revision ?? draft.headRevision) as Row | undefined, '该创作版本不存在');
  }
  drafts(sessionId: string, options: { before?: number; limit?: number; archived?: boolean; kind?: MediaKind; name?: string } = {}): Page<Draft> {
    this.session(sessionId);
    let filter = options.archived ? '' : " AND json_extract(data,'$.archivedAt') IS NULL";
    const values: SQLInputValue[] = [];
    if (options.kind) { filter += " AND EXISTS(SELECT 1 FROM json_each(drafts.data,'$.outputKinds') WHERE value=?)"; values.push(options.kind); }
    if (options.name) { filter += " AND instr(lower(json_extract(data,'$.name')),lower(?))>0"; values.push(options.name); }
    return this.page('drafts', sessionId, options, filter, values);
  }
  revisions(sessionId: string, draftId: string, options: { before?: number; limit?: number } = {}): Page<Omit<Revision, 'canvas'>> {
    this.draft(sessionId, draftId);
    const limit = limitOf(options.limit);
    const rows = this.db.prepare('SELECT data,revision AS ordinal FROM draft_revisions WHERE draft_id=? AND revision<? ORDER BY revision DESC LIMIT ?').all(draftId, beforeOf(options.before), limit + 1) as unknown as Row[];
    return { items: rows.slice(0, limit).map(r => { const item = decode<Omit<Revision, 'canvas'> & { canvas?: Canvas }>(r); delete item.canvas; return item; }),
      ...(rows.length > limit ? { nextCursor: Number(rows[limit - 1].ordinal) } : {}) };
  }
  private page<T>(table: 'drafts' | 'runs' | 'assets', sessionId: string, options: { before?: number; limit?: number }, filter = '', values: SQLInputValue[] = []): Page<T> {
    const limit = limitOf(options.limit);
    const rows = this.db.prepare(`SELECT data,ordinal FROM ${table} WHERE session_id=? AND ordinal<?${filter} ORDER BY ordinal DESC LIMIT ?`).all(sessionId, beforeOf(options.before), ...values, limit + 1) as unknown as Row[];
    return { items: rows.slice(0, limit).map(decode<T>), ...(rows.length > limit ? { nextCursor: Number(rows[limit - 1].ordinal) } : {}) };
  }
  private assertWriter(sessionId: string, taskId?: string) {
    if (this.session(sessionId).deletedAt) throw new AgentHttpError(410, '此会话已清理，仅保留入库依赖的来源记录');
    const placeholders = activeStates.map(() => '?').join(',');
    const active = this.db.prepare(`SELECT id FROM tasks WHERE session_id=? AND state IN (${placeholders})`).all(sessionId, ...activeStates);
    if (active.some(row => row.id !== taskId)) throw new AgentHttpError(409, '请先等待或停止当前任务');
    if (taskId) {
      const task = this.store.task(taskId);
      if (task.sessionId !== sessionId || task.state !== 'running') throw new AgentHttpError(409, '该任务当前不能修改创作');
    }
  }
  private write<T>(sessionId: string, identity: WriteIdentity, kind: OperationKind, request: unknown, fn: () => T, pending = false): T {
    let accepted: Operation | undefined;
    try { return this.transaction(() => {
      this.session(sessionId);
      const requestDigest = digest({ kind, request });
      let operation: Operation | undefined;
      if (identity.operationId) {
        operation = this.operation(sessionId, identity.operationId);
        if (operation.taskId !== identity.taskId || operation.kind !== kind) throw new AgentHttpError(409, '操作步骤与任务或动作类型不一致');
        if (operation.requestDigest && operation.requestDigest !== requestDigest) throw new AgentHttpError(409, '同一操作不能用于不同参数');
        if (operation.state === 'completed') return structuredClone(operation.result) as T;
        if (operation.state === 'running' && operation.result !== undefined) return structuredClone(operation.result) as T;
        if (operation.state === 'failed') throw new AgentHttpError(409, '已失败的操作需要新的修复步骤');
        for (const dependency of operation.dependsOn) if (this.operation(sessionId, dependency).state !== 'completed') throw new AgentHttpError(409, '请先完成前置操作');
      } else {
        if (this.db.prepare('SELECT 1 FROM workspace_request_cancellations WHERE session_id=? AND request_id=?').get(sessionId, identity.requestId!)) throw new AgentHttpError(409, '该本地保存请求已取消');
        const receipt = this.db.prepare('SELECT digest,result FROM workspace_requests WHERE session_id=? AND request_id=?').get(sessionId, identity.requestId!);
        if (receipt) {
          if (receipt.digest !== requestDigest) throw new AgentHttpError(409, '请求 ID 已用于其他操作');
          return JSON.parse(String(receipt.result)) as T;
        }
      }
      this.assertWriter(sessionId, identity.taskId);
      if (operation) accepted = { ...operation, requestDigest };
      const result = fn();
      if (operation) this.saveOperation({ ...operation, state: pending ? 'running' : 'completed', requestDigest, result });
      else this.db.prepare('INSERT INTO workspace_requests VALUES(?,?,?,?)').run(sessionId, identity.requestId!, requestDigest, json(result));
      return result;
    }); } catch (error) {
      // Roll back graph changes first, then durably close an accepted failed step. Repair must have a new identity.
      if (accepted) {
        const failed = accepted;
        this.transaction(() => this.saveOperation({ ...failed, state: 'failed', error: error instanceof AgentHttpError ? error.message : '操作执行失败' }));
      }
      throw error;
    }
  }
  /** Serialize cancellation with commit. A delayed POST can never revive a discarded outbox entry. */
  cancelLocalRequest<T>(sessionId: string, requestId: string, kind: 'edit_workflow' | 'fork_workflow', request: unknown): T | undefined {
    return this.transaction(() => {
      this.session(sessionId);
      const requestDigest = digest({ kind, request });
      const receipt = this.db.prepare('SELECT digest,result FROM workspace_requests WHERE session_id=? AND request_id=?').get(sessionId, requestId);
      if (receipt) {
        if (receipt.digest !== requestDigest) throw new AgentHttpError(409, '请求 ID 已用于其他操作');
        return JSON.parse(String(receipt.result)) as T;
      }
      const canceled = this.db.prepare('SELECT digest FROM workspace_request_cancellations WHERE session_id=? AND request_id=?').get(sessionId, requestId);
      if (canceled && canceled.digest !== requestDigest) throw new AgentHttpError(409, '请求 ID 已用于其他操作');
      if (!canceled) this.db.prepare('INSERT INTO workspace_request_cancellations VALUES(?,?,?)').run(sessionId, requestId, requestDigest);
      return undefined;
    });
  }
  /** The immutable request is checked before validation/building, so retries do not re-evaluate old commands against a new head or environment. */
  command<T>(sessionId: string, identity: WriteIdentity, kind: OperationKind, request: unknown, targetDraftId: string | undefined, execute: () => T): T {
    return this.write(sessionId, identity, kind, request, () => {
      if (identity.operationId && this.operation(sessionId, identity.operationId).targetDraftId !== targetDraftId) throw new AgentHttpError(409, '操作步骤的目标创作不一致');
      return execute();
    });
  }
  createDraft(sessionId: string, input: DraftInput, identity: WriteIdentity): { draft: Draft; revision: Revision } {
    return this.write(sessionId, identity, input.forkedFrom ? 'fork_workflow' : 'create_workflow', input, () => {
      if (identity.operationId && this.operation(sessionId, identity.operationId).targetDraftId !== input.forkedFrom?.draftId) throw new AgentHttpError(409, '操作步骤的目标创作不一致');
      return this.createDraftSnapshot(sessionId, input, identity.taskId);
    });
  }
  /** Internal transaction primitive; callers must establish a command identity first. */
  createDraftSnapshot(sessionId: string, input: DraftInput, taskId?: string): { draft: Draft; revision: Revision } {
      if (!this.depth) throw new Error('Draft writes require a workspace transaction');
      if (input.forkedFrom) this.revision(sessionId, input.forkedFrom.draftId, input.forkedFrom.revision);
      const now = Date.now();
      const draft: Draft = { id: randomUUID(), sessionId, name: input.name, headRevision: 0, outputKinds: input.outputKinds,
        created: now, updated: now, ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}), ...(input.forkedFrom ? { forkedFrom: input.forkedFrom } : {}) };
      this.db.prepare('INSERT INTO drafts(id,session_id,head_revision,data) VALUES(?,?,?,?)').run(draft.id, sessionId, 0, json(draft));
      const revision = this.appendRevision(draft, 0, input.canvas, input.bindings ?? [], input.summary ?? '创建工作流', undefined, taskId);
      const updated = this.draft(sessionId, draft.id);
      this.store.event(sessionId, taskId ?? null, 'draft_created', { draft: updated });
      return { draft: updated, revision };
  }
  commitRevision(sessionId: string, draftId: string, input: RevisionInput, identity: WriteIdentity, kind: 'edit_workflow' | 'replace_workflow_template' | 'restore_workflow' = 'edit_workflow'): Revision {
    return this.write(sessionId, identity, kind, { draftId, ...input }, () => {
      if (identity.operationId && this.operation(sessionId, identity.operationId).targetDraftId !== draftId) throw new AgentHttpError(409, '操作步骤的目标创作不一致');
      return this.commitRevisionSnapshot(sessionId, draftId, input, identity.taskId);
    });
  }
  commitRevisionSnapshot(sessionId: string, draftId: string, input: RevisionInput, taskId?: string): Revision {
    if (!this.depth) throw new Error('Revision writes require a workspace transaction');
    const draft = this.draft(sessionId, draftId);
    if (draft.archivedAt) throw new AgentHttpError(409, '请先取消归档再编辑此创作');
    this.revision(sessionId, draftId, input.sourceRevision);
    return this.appendRevision(draft, input.expectedHeadRevision, input.canvas, input.bindings, input.summary, input.sourceRevision, taskId);
  }
  restore(sessionId: string, draftId: string, sourceRevision: number, expectedHeadRevision: number, identity: WriteIdentity) {
    const source = this.revision(sessionId, draftId, sourceRevision);
    return this.commitRevision(sessionId, draftId, { canvas: source.canvas, bindings: source.bindings, expectedHeadRevision, sourceRevision, summary: `恢复版本 ${sourceRevision}` }, identity, 'restore_workflow');
  }
  fork(sessionId: string, draftId: string, sourceRevision: number, name: string, identity: WriteIdentity) {
    const source = this.revision(sessionId, draftId, sourceRevision);
    const draft = this.draft(sessionId, draftId);
    return this.createDraft(sessionId, { canvas: source.canvas, bindings: source.bindings, name, outputKinds: draft.outputKinds, forkedFrom: { draftId, revision: sourceRevision }, summary: `从 ${draft.name} 版本 ${sourceRevision} 分出` }, identity);
  }
  private appendRevision(draft: Draft, expectedHead: number, canvas: Canvas, bindings: AssetBinding[], summary: string, sourceRevision?: number, taskId?: string): Revision {
    if (draft.headRevision !== expectedHead) throw new AgentHttpError(409, `创作已有新版本 ${draft.headRevision}，请重新读取`);
    this.validateBindings(draft.sessionId, canvas, bindings);
    const revision: Revision = { sessionId: draft.sessionId, draftId: draft.id, revision: expectedHead + 1, canvas, bindings,
      digest: digest({ nodes: canvas.nodes, links: canvas.links, bindings }), summary, created: Date.now(),
      ...(expectedHead ? { previousHeadRevision: expectedHead } : {}), ...(sourceRevision ? { sourceRevision } : {}), ...(taskId ? { createdByTaskId: taskId } : {}) };
    this.db.prepare('INSERT INTO draft_revisions VALUES(?,?,?,?)').run(draft.id, revision.revision, draft.sessionId, json(revision));
    for (const binding of bindings) this.db.prepare('INSERT INTO revision_assets VALUES(?,?,?,?,?)').run(draft.sessionId, draft.id, revision.revision, binding.id, binding.assetId);
    const outputKinds: MediaKind[] = [];
    if (canvas.nodes.some(node => node.type === 'SaveImage')) outputKinds.push('image');
    if (canvas.nodes.some(node => node.type === 'SaveVideo')) outputKinds.push('video');
    if (canvas.nodes.some(node => node.type === 'SaveAudio' || (node.type === 'CreateVideo' && node.inputs?.some(input => input.name === 'audio' && input.link != null)))) outputKinds.push('audio');
    const next = { ...draft, headRevision: revision.revision, updated: revision.created, ...(outputKinds.length ? { outputKinds } : {}) };
    this.db.prepare('UPDATE drafts SET head_revision=?,data=? WHERE id=?').run(next.headRevision, json(next), draft.id);
    this.store.event(draft.sessionId, taskId ?? null, 'revision_created', { draftId: draft.id, revision: revision.revision, summary, draft: next });
    return structuredClone(revision);
  }
  validateBindings(sessionId: string, canvas: Canvas, bindings: AssetBinding[]) {
    const keys = new Set<string>(), ids = new Set<string>();
    const loaders: Record<string, { input: string; kind: MediaKind }> = { LoadImage: { input: 'image', kind: 'image' }, LoadAudio: { input: 'audio', kind: 'audio' }, LoadVideo: { input: 'file', kind: 'video' } };
    for (const binding of bindings) {
      const asset = this.asset(sessionId, binding.assetId);
      const node = canvas.nodes.find(node => String(node.id) === binding.nodeId);
      const loader = node && loaders[node.type];
      if (!loader || loader.input !== binding.inputName || loader.kind !== asset.kind) throw new AgentHttpError(422, '参考素材与加载节点的输入类型不匹配');
      if (node?.inputs?.find(input => input.name === binding.inputName)?.link != null) throw new AgentHttpError(422, '参考文件输入不能同时连接节点与绑定素材');
      const key = canonicalJson([binding.nodeId, binding.inputName]);
      if (!binding.id || ids.has(binding.id) || keys.has(key)) throw new AgentHttpError(422, '同一输入不能重复绑定素材');
      ids.add(binding.id); keys.add(key);
    }
  }
  operation(sessionId: string, id: string): Operation {
    return exists(this.db.prepare('SELECT data FROM workspace_operations WHERE session_id=? AND id=?').get(sessionId, id) as Row | undefined, '本对话中找不到该操作步骤');
  }
  operations(sessionId: string, taskId: string): Operation[] {
    const task = this.store.task(taskId);
    if (task.sessionId !== sessionId) throw new AgentHttpError(404, '任务不在本对话中');
    return (this.db.prepare('SELECT data FROM workspace_operations WHERE task_id=? ORDER BY ordinal').all(taskId) as unknown as Row[]).map(decode<Operation>);
  }
  plan(sessionId: string, taskId: string, plans: OperationPlan[]): Operation[] {
    return this.transaction(() => {
      this.assertWriter(sessionId, taskId);
      const existing = this.operations(sessionId, taskId);
      if (plans.length > 24 || existing.length + plans.filter(p => !existing.some(e => e.stepKey === p.stepKey)).length > 48) throw new AgentHttpError(422, '本轮操作步骤过多');
      const keys = new Map(existing.map(op => [op.stepKey, op]));
      const result: Operation[] = [];
      for (const item of plans) {
        if (!item.stepKey || item.stepKey.length > 100) throw new AgentHttpError(400, '操作步骤名称不合法');
        if (!keys.has(item.stepKey)) {
          if (item.kind !== 'create_workflow' && !item.targetDraftId) throw new AgentHttpError(422, '此操作需要已存在的 targetDraftId；请先创建草稿，取得返回的 draftId 后再规划后续步骤');
          if (item.kind === 'create_workflow' && item.targetDraftId) throw new AgentHttpError(422, '创建新草稿的步骤不能指定已有 targetDraftId；调整或分支请使用对应操作');
        }
        if (item.targetDraftId) this.draft(sessionId, item.targetDraftId);
        const dependencies = (item.dependsOn ?? []).map(key => {
          const dependency = keys.get(key);
          if (!dependency || dependency.stepKey === item.stepKey) throw new AgentHttpError(422, '前置步骤必须先于当前步骤');
          return dependency.id;
        });
        const repair = item.repairOf ? keys.get(item.repairOf) : undefined;
        if (item.repairOf && (!repair || repair.state !== 'failed' || repair.stepKey === item.stepKey)) throw new AgentHttpError(422, '修复步骤必须关联本轮先前失败的操作');
        const prior = keys.get(item.stepKey);
        if (prior) {
          if (prior.kind !== item.kind || prior.targetDraftId !== item.targetDraftId || prior.repairOf !== repair?.id || canonicalJson(prior.dependsOn) !== canonicalJson(dependencies)) throw new AgentHttpError(409, '已登记的操作步骤不能改写');
          result.push(prior); continue;
        }
        const operation: Operation = { ...item, repairOf: repair?.id, id: randomUUID(), sessionId, taskId, dependsOn: dependencies, state: 'planned', created: Date.now() };
        this.db.prepare('INSERT INTO workspace_operations(id,session_id,task_id,step_key,data) VALUES(?,?,?,?,?)').run(operation.id, sessionId, taskId, item.stepKey, json(operation));
        keys.set(item.stepKey, operation); result.push(operation);
      }
      return result;
    });
  }
  private saveOperation(operation: Operation) {
    this.db.prepare('UPDATE workspace_operations SET data=? WHERE id=?').run(json(operation), operation.id);
  }
  asset(sessionId: string, id: string): Asset {
    return exists(this.db.prepare('SELECT data FROM assets WHERE session_id=? AND id=?').get(sessionId, id) as Row | undefined, '本对话中找不到该素材');
  }
  assets(sessionId: string, options: { before?: number; limit?: number; kind?: MediaKind; runId?: string; draftId?: string } = {}): Page<Asset> {
    this.session(sessionId);
    let filter = ''; const values: SQLInputValue[] = [];
    if (options.kind) { filter += ' AND kind=?'; values.push(options.kind); }
    if (options.runId) { this.run(sessionId, options.runId); filter += ' AND source_run_id=?'; values.push(options.runId); }
    if (options.draftId) { this.draft(sessionId, options.draftId); filter += ' AND source_run_id IN (SELECT id FROM runs WHERE draft_id=?)'; values.push(options.draftId); }
    return this.page('assets', sessionId, options, filter, values);
  }
  runAssets(sessionId: string, runId: string, after = 0, limit = 20): Page<Asset> {
    this.run(sessionId, runId); limitOf(limit);
    if (!Number.isSafeInteger(after) || after < 0) throw new AgentHttpError(400, '分页游标不合法');
    const rows = this.db.prepare('SELECT data,ordinal FROM assets WHERE session_id=? AND source_run_id=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(sessionId, runId, after, limit + 1) as unknown as Row[];
    return { items: rows.slice(0, limit).map(decode<Asset>), ...(rows.length > limit ? { nextCursor: Number(rows[limit - 1].ordinal) } : {}) };
  }
  assetUses(sessionId: string, assetId: string, before = Number.MAX_SAFE_INTEGER, limit = 30) {
    this.asset(sessionId, assetId); beforeOf(before); limitOf(limit);
    const rows = this.db.prepare(`SELECT a.rowid AS ordinal,a.draft_id,a.revision,a.binding_id,d.data FROM revision_assets a
      JOIN drafts d ON d.id=a.draft_id WHERE a.session_id=? AND a.asset_id=? AND a.rowid<? ORDER BY a.rowid DESC LIMIT ?`).all(sessionId, assetId, before, limit + 1);
    return { items: rows.slice(0, limit).map(row => { const draft = JSON.parse(String(row.data)) as Draft; return { id: `${row.draft_id}:${row.revision}:${row.binding_id}`, draftId: String(row.draft_id), revision: Number(row.revision), bindingId: String(row.binding_id), draftName: draft.name, headRevision: draft.headRevision }; }), ...(rows.length > limit ? { nextCursor: Number(rows[limit - 1].ordinal) } : {}) };
  }
  registerAsset(asset: Asset, location?: AssetLocation): Asset {
    return this.transaction(() => {
      if (this.session(asset.sessionId).deletedAt) throw new AgentHttpError(410, '此会话已清理，仅保留入库依赖的来源记录');
      if (asset.captureState === 'ready' && !/^[0-9a-f]{64}$/.test(asset.blobDigest ?? '')) throw new AgentHttpError(422, '可用素材必须具有有效的内容摘要');
      if (asset.origin === 'generated' && !asset.sourceRunId) throw new AgentHttpError(422, '生成素材必须属于一个生成记录');
      if (asset.sourceRunId) {
        this.run(asset.sessionId, asset.sourceRunId);
        if (!asset.outputLocator) throw new AgentHttpError(422, '生成素材缺少输出位置');
        const row = this.db.prepare('SELECT data FROM assets WHERE source_run_id=? AND output_locator=?').get(asset.sourceRunId, asset.outputLocator) as Row | undefined;
        if (row) return decode<Asset>(row);
      }
      this.db.prepare('INSERT INTO assets(id,session_id,source_run_id,output_locator,kind,capture_state,data) VALUES(?,?,?,?,?,?,?)').run(asset.id, asset.sessionId, asset.sourceRunId ?? null, asset.outputLocator ?? null, asset.kind, asset.captureState, json(asset));
      if (location) {
        if (location.assetId !== asset.id) throw new AgentHttpError(422, '素材位置归属不匹配');
        this.putLocation(location);
      }
      this.store.event(asset.sessionId, null, 'asset_registered', { asset });
      return asset;
    });
  }
  updateAsset(sessionId: string, id: string, update: Pick<Partial<Asset>, 'captureState' | 'blobDigest' | 'metadata' | 'captured' | 'error' | 'name'>): Asset {
    return this.transaction(() => {
      const asset = this.asset(sessionId, id);
      if (asset.blobDigest && update.blobDigest !== undefined && update.blobDigest !== asset.blobDigest) throw new AgentHttpError(409, '素材内容不可改写，请登记新素材');
      const next = { ...asset, ...update };
      if (next.captureState === 'ready' && !/^[0-9a-f]{64}$/.test(next.blobDigest ?? '')) throw new AgentHttpError(422, '可用素材必须具有有效的内容摘要');
      this.db.prepare('UPDATE assets SET capture_state=?,data=? WHERE id=?').run(next.captureState, json(next), id);
      this.store.event(sessionId, null, next.captureState === 'ready' ? 'asset_ready' : 'asset_state', { asset: next });
      return next;
    });
  }
  locations(sessionId: string, assetId: string): AssetLocation[] {
    this.asset(sessionId, assetId);
    return (this.db.prepare('SELECT data FROM asset_locations WHERE asset_id=? ORDER BY rowid').all(assetId) as unknown as Row[]).map(decode<AssetLocation>);
  }
  putLocation(location: AssetLocation) {
    const key = canonicalJson(location.ref);
    const prior = this.db.prepare('SELECT id FROM asset_locations WHERE asset_id=? AND server_id=? AND role=? AND ref_key=?').get(location.assetId, location.serverId, location.role, key);
    const next = { ...location, id: prior ? String(prior.id) : location.id };
    this.db.prepare('INSERT INTO asset_locations VALUES(?,?,?,?,?,?) ON CONFLICT(asset_id,server_id,role,ref_key) DO UPDATE SET data=excluded.data').run(next.id, next.assetId, next.serverId, next.role, key, json(next));
  }
  materialization(assetId: string, blobDigest: string, serverId: string, loaderKind: string): Materialization | undefined {
    const row = this.db.prepare('SELECT data FROM asset_materializations WHERE asset_id=? AND blob_digest=? AND server_id=? AND loader_kind=?').get(assetId, blobDigest, serverId, loaderKind) as Row | undefined;
    return row ? decode<Materialization>(row) : undefined;
  }
  putMaterialization(value: Materialization) {
    this.db.prepare('INSERT INTO asset_materializations VALUES(?,?,?,?,?) ON CONFLICT(asset_id,blob_digest,server_id,loader_kind) DO UPDATE SET data=excluded.data').run(value.assetId, value.blobDigest, value.serverId, value.loaderKind, json(value));
  }
  run(sessionId: string, id: string): Run {
    return exists(this.db.prepare('SELECT data FROM runs WHERE session_id=? AND id=?').get(sessionId, id) as Row | undefined, '本对话中找不到该生成记录');
  }
  runs(sessionId: string, options: { before?: number; limit?: number; draftId?: string } = {}): Page<Run> {
    this.session(sessionId);
    if (options.draftId) this.draft(sessionId, options.draftId);
    return this.page('runs', sessionId, options, options.draftId ? ' AND draft_id=?' : '', options.draftId ? [options.draftId] : []);
  }
  insertRun(run: Run) {
    this.revision(run.sessionId, run.draftId, run.revision);
    run.generation ??= Number(this.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE draft_id=?').get(run.draftId)!.n) + 1;
    this.db.prepare('INSERT INTO runs(id,session_id,task_id,draft_id,revision,submission_key,state,data) VALUES(?,?,?,?,?,?,?,?)').run(run.id, run.sessionId, run.taskId ?? null, run.draftId, run.revision, run.submissionKey, run.state, json(run));
  }
  createRun(sessionId: string, draftId: string, revision: number, serverId: string, identity: { taskId: string; operationId: string }): { runId: string } {
    return this.write(sessionId, identity, 'submit_preview', { draftId, revision, serverId }, () => {
      if (this.draft(sessionId, draftId).archivedAt) throw new AgentHttpError(409, '请先取消归档再生成此创作');
      if (this.operation(sessionId, identity.operationId).targetDraftId !== draftId) throw new AgentHttpError(409, '操作步骤的目标创作不一致');
      if (this.activeRuns().some(run => run.taskId === identity.taskId)) throw new AgentHttpError(409, '本轮已有生成正在处理，请等待其完成');
      this.revision(sessionId, draftId, revision);
      const run: Run = { id: randomUUID(), sessionId, taskId: identity.taskId, operationId: identity.operationId, draftId, revision, serverId,
        state: 'preparing', submissionKey: randomUUID(), inputManifest: [], outputAssetIds: [], created: Date.now() };
      this.insertRun(run);
      this.store.event(sessionId, identity.taskId, 'run_state', { run: runSummary(run) });
      return { runId: run.id };
    }, true);
  }
  activeRuns(): Run[] {
    return (this.db.prepare("SELECT data FROM runs WHERE state IN ('preparing','awaiting_approval','submitting','reconciling','queued','running') ORDER BY ordinal").all() as unknown as Row[]).map(decode<Run>);
  }
  pendingAssets(limit = 4): Asset[] {
    return (this.db.prepare("SELECT data FROM assets WHERE capture_state='pending_capture' ORDER BY ordinal LIMIT ?").all(limitOf(limit)) as unknown as Row[]).map(decode<Asset>);
  }
  updateRun(sessionId: string, runId: string, changes: Partial<Pick<Run, 'state' | 'promptId' | 'executionSnapshot' | 'inputManifest' | 'approvalDigest' | 'approvedAt' | 'outputAssetIds' | 'outputsIncomplete' | 'rawOutputs' | 'submitted' | 'completed' | 'diagnostic'>>): Run {
    return this.transaction(() => {
      const current = this.run(sessionId, runId);
      const transitions: Record<RunState, RunState[]> = {
        preparing: ['awaiting_approval', 'submitting', 'failed', 'cancelled'], awaiting_approval: ['submitting', 'failed', 'cancelled'],
        submitting: ['queued', 'running', 'reconciling', 'failed', 'unknown'], reconciling: ['queued', 'running', 'succeeded', 'failed', 'unknown'],
        queued: ['running', 'succeeded', 'failed', 'unknown'], running: ['succeeded', 'failed', 'unknown'],
        succeeded: [], failed: [], cancelled: [], unknown: ['reconciling'],
      };
      if (changes.state && changes.state !== current.state && !transitions[current.state].includes(changes.state)) throw new AgentHttpError(409, '生成状态不能执行该转换');
      if (!['preparing', 'awaiting_approval'].includes(current.state)) {
        for (const key of ['executionSnapshot', 'inputManifest', 'approvalDigest'] as const) if (changes[key] !== undefined && canonicalJson(changes[key]) !== canonicalJson(current[key])) throw new AgentHttpError(409, '已提交的执行快照不可改写');
      }
      if (current.promptId && changes.promptId && current.promptId !== changes.promptId) throw new AgentHttpError(409, '已确认的生成 ID 不可替换');
      for (const id of changes.outputAssetIds ?? []) if (this.asset(sessionId, id).sourceRunId !== runId) throw new AgentHttpError(422, '生成结果的素材归属不匹配');
      const next: Run = { ...current, ...changes };
      if (next.state === 'submitting' && (!next.executionSnapshot || !next.approvalDigest)) throw new AgentHttpError(422, '提交前必须固定工作流与参考输入');
      if (next.state === 'submitting' && current.state !== 'submitting') {
        const revision = this.revision(sessionId, next.draftId, next.revision);
        const seen = new Set<string>();
        for (const input of next.inputManifest) {
          const binding = revision.bindings.find(binding => binding.id === input.bindingId);
          const asset = this.asset(sessionId, input.assetId);
          if (!binding || binding.assetId !== input.assetId || seen.has(input.bindingId) || asset.blobDigest !== input.blobDigest || asset.captureState !== 'ready' || input.serverId !== next.serverId || input.materializedRef.type !== 'input') throw new AgentHttpError(422, '执行输入与固定版本的素材绑定不一致');
          seen.add(input.bindingId);
          this.db.prepare('INSERT INTO run_inputs VALUES(?,?,?,?)').run(sessionId, runId, input.bindingId, input.assetId);
        }
        if (seen.size !== revision.bindings.length) throw new AgentHttpError(422, '执行缺少参考素材');
      }
      this.db.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run(next.state, json(next), runId);
      this.store.event(sessionId, next.taskId ?? null, 'run_state', { run: runSummary(next) });
      if (next.operationId && ['succeeded', 'failed', 'cancelled', 'unknown'].includes(next.state)) {
        const operation = this.operation(sessionId, next.operationId);
        this.saveOperation({ ...operation, state: next.state === 'succeeded' ? 'completed' : 'failed', result: { runId }, ...(next.state === 'succeeded' ? {} : { error: '生成未成功完成，请查看该生成记录' }) });
      }
      return next;
    });
  }
}
