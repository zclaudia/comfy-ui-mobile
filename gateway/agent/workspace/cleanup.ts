import { lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentHttpError, activeStates } from '../store.js';
import type { Task } from '../store.js';
import type { AssetService } from './assets.js';
import type { WorkspaceLibrary } from './library.js';
import type { WorkspaceRepository } from './repository.js';
import type { Asset, Draft, LibrarySaveOperation, Revision, Run } from './types.js';
import { digest } from './digest.js';

type Counts = { drafts: number; revisions: number; runs: number; assets: number; messages: number };
export interface CleanupPlan {
  sessionId: string; serverId: string; token: string; total: Counts; retained: Counts;
  reclaimableBytes: number; retainedBytes: number; missingBlobs: number; unknownBlobs: number;
  libraries: { name: string; filename: string; serverId: string }[]; blockers: string[];
}
export interface CleanupOperation {
  requestId: string; sessionId: string; state: 'deleting_files' | 'completed'; plan: CleanupPlan;
  files: { digest: string; state: 'pending' | 'removed' | 'missing' | 'protected' | 'failed'; bytes: number; error?: string }[];
  created: number; completed?: number;
}
const revKey = (draftId: string, revision: number) => `${draftId}:${revision}`;
const uncertainRuns = new Set(['preparing', 'awaiting_approval', 'submitting', 'reconciling', 'queued', 'running', 'unknown']);

/** Explicit archived-chat purge. Pinned provenance stays reachable; remote input/output files are never removed. */
export class WorkspaceCleanup {
  private flights = new Map<string, Promise<CleanupOperation>>();
  constructor(readonly repo: WorkspaceRepository, readonly assets: AssetService, readonly library: WorkspaceLibrary, private readonly remove: typeof unlink = unlink) {}
  operation(sessionId: string): CleanupOperation | undefined {
    const row = this.repo.db.prepare('SELECT data FROM workspace_cleanup_ops WHERE session_id=?').get(sessionId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  private snapshot(sessionId: string) {
    return this.repo.transaction(() => {
      const session = this.repo.session(sessionId);
      const read = <T>(table: string) => this.repo.db.prepare(`SELECT data FROM ${table} WHERE session_id=? ORDER BY rowid`).all(sessionId).map(row => JSON.parse(String(row.data)) as T);
      const drafts = read<Draft>('drafts'), revisions = read<Revision>('draft_revisions'), runs = read<Run>('runs'), assets = read<Asset>('assets');
      const tasks = read<Task>('tasks'), operations = read<LibrarySaveOperation>('library_save_ops');
      const pins = this.repo.db.prepare('SELECT * FROM library_asset_refs ORDER BY server_id,workflow_id,asset_id,blob_digest').all();
      const external = this.repo.db.prepare("SELECT id,json_extract(data,'$.blobDigest') AS digest FROM assets WHERE session_id<>? ORDER BY id").all(sessionId);
      const messages = Number(this.repo.db.prepare('SELECT count(*) AS n FROM events WHERE session_id=?').get(sessionId)!.n);
      const lastSeq = this.repo.db.prepare('SELECT max(seq) AS seq FROM events WHERE session_id=?').get(sessionId)!.seq;
      const busy = this.assets.busy(sessionId) || this.library.busy(sessionId);
      const fingerprint = digest({ session, drafts, revisions, runs, assets, tasks, operations, pins, external, messages, lastSeq, busy });
      const keepAssets = new Set<string>(), keepRuns = new Set<string>(), keepRevisions = new Set<string>(), keepDrafts = new Set<string>();
      const assetMap = new Map(assets.map(asset => [asset.id, asset])); const runMap = new Map(runs.map(run => [run.id, run]));
      const draftMap = new Map(drafts.map(draft => [draft.id, draft])); const revisionMap = new Map(revisions.map(revision => [revKey(revision.draftId, revision.revision), revision]));
      const keepAsset = (id: string) => {
        if (keepAssets.has(id)) return; const asset = assetMap.get(id); if (!asset) throw new AgentHttpError(409, '来源素材不完整，暂不能清理');
        keepAssets.add(id); if (asset.sourceRunId) keepRun(asset.sourceRunId);
      };
      const keepRevision = (draftId: string, revision: number) => {
        const key = revKey(draftId, revision); if (keepRevisions.has(key)) return;
        const value = revisionMap.get(key); if (!value) throw new AgentHttpError(409, '来源版本不完整，暂不能清理');
        keepRevisions.add(key);
        if (!keepDrafts.has(draftId)) {
          keepDrafts.add(draftId); const draft = draftMap.get(draftId)!;
          keepRevision(draftId, draft.headRevision);
          if (draft.forkedFrom && draftMap.has(draft.forkedFrom.draftId)) keepRevision(draft.forkedFrom.draftId, draft.forkedFrom.revision);
        }
        value.bindings.forEach(binding => keepAsset(binding.assetId));
      };
      const keepRun = (id: string) => {
        if (keepRuns.has(id)) return; const run = runMap.get(id); if (!run) throw new AgentHttpError(409, '来源生成记录不完整，暂不能清理');
        keepRuns.add(id); keepRevision(run.draftId, run.revision);
        run.inputManifest.forEach(input => keepAsset(input.assetId)); run.outputAssetIds.forEach(keepAsset);
      };
      for (const pin of pins) if (assetMap.has(String(pin.asset_id))) keepAsset(String(pin.asset_id));
      // Save intents retain their fixed revision, including uncertain or failed writes whose pins were never released.
      for (const op of operations) keepRevision(op.draftId, op.revision);
      for (const draft of drafts) {
        if (draft.lastLibrarySave) keepRevision(draft.id, draft.lastLibrarySave.revision);
        else if (draft.sourceRef) keepRevision(draft.id, 1);
      }
      const keepTasks = new Set(runs.filter(run => keepRuns.has(run.id) && run.taskId).map(run => run.taskId!));
      const protectedDigests = new Set([...external.map(row => String(row.digest ?? '')), ...pins.map(row => String(row.blob_digest)), ...assets.filter(asset => keepAssets.has(asset.id)).map(asset => asset.blobDigest ?? '')]);
      const blockers = [
        ...(!session.archivedAt ? ['请先归档会话再清理'] : []),
        ...(tasks.some(task => activeStates.includes(task.state)) ? ['请先等待或停止当前任务'] : []),
        ...(runs.some(run => uncertainRuns.has(run.state)) ? ['仍有生成结果尚未确认，暂不能清理'] : []),
        ...(operations.some(op => ['pending', 'applying', 'reconciling'].includes(op.state)) ? ['请先完成或核对入库操作'] : []),
        ...(busy || assets.some(asset => ['pending_capture', 'capturing'].includes(asset.captureState)) ? ['素材仍在准备，请稍后重新检查'] : []),
      ];
      const libraries = [...new Map(operations.map(op => [`${op.target.serverId}:${op.target.workflowId}`, { name: op.target.name, filename: op.target.filename, serverId: op.target.serverId }])).values()];
      return { session, fingerprint, assets, drafts, revisions, runs, tasks, keepAssets, keepRuns, keepRevisions, keepDrafts, keepTasks, protectedDigests, blockers, libraries, messages };
    });
  }
  private async prepare(sessionId: string) {
    const snapshot = this.snapshot(sessionId);
    const blobs = await Promise.all([...new Set(snapshot.assets.map(asset => asset.blobDigest).filter((value): value is string => !!value))].map(async value => {
      if (!/^[0-9a-f]{64}$/.test(value)) throw new AgentHttpError(409, '素材摘要不合法，暂不能清理');
      try { const stat = await lstat(join(this.assets.options.directory, `${value}.blob`)); return { digest: value, size: stat.size, owned: stat.isFile() && !stat.isSymbolicLink(), missing: false, stamp: `${stat.ino}:${stat.mtimeMs}` }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { digest: value, size: 0, owned: false, missing: true, stamp: '' }; throw error; }
    }));
    const candidates = blobs.filter(blob => !snapshot.protectedDigests.has(blob.digest) && blob.owned);
    const plan: CleanupPlan = { sessionId, serverId: this.assets.options.serverId, token: digest({ fingerprint: snapshot.fingerprint, blobs }),
      total: { drafts: snapshot.drafts.length, revisions: snapshot.revisions.length, runs: snapshot.runs.length, assets: snapshot.assets.length, messages: snapshot.messages },
      retained: { drafts: snapshot.keepDrafts.size, revisions: snapshot.keepRevisions.size, runs: snapshot.keepRuns.size, assets: snapshot.keepAssets.size, messages: 0 },
      reclaimableBytes: candidates.reduce((sum, blob) => sum + blob.size, 0), retainedBytes: blobs.filter(blob => snapshot.protectedDigests.has(blob.digest)).reduce((sum, blob) => sum + blob.size, 0),
      missingBlobs: blobs.filter(blob => blob.missing).length, unknownBlobs: blobs.filter(blob => !blob.owned && !blob.missing).length,
      libraries: snapshot.libraries, blockers: snapshot.blockers };
    return { snapshot, plan, candidates };
  }
  async preview(sessionId: string) {
    const operation = this.operation(sessionId);
    return operation ? { plan: operation.plan, operation } : { plan: (await this.prepare(sessionId)).plan };
  }
  execute(sessionId: string, requestId: string, token: string): Promise<CleanupOperation> {
    const existing = this.flights.get(sessionId);
    if (existing) return existing.then(op => { if (op.requestId !== requestId || op.plan.token !== token) throw new AgentHttpError(409, '另一清理操作正在处理'); return op; });
    const flight = this.assets.withStorageLock(async () => {
      let operation = this.operation(sessionId);
      if (operation && (operation.requestId !== requestId || operation.plan.token !== token)) throw new AgentHttpError(409, '请继续原清理操作');
      if (!operation) {
        const prepared = await this.prepare(sessionId);
        if (prepared.plan.token !== token) throw new AgentHttpError(409, '会话或引用已变化，请重新查看清理影响');
        if (prepared.plan.blockers.length) throw new AgentHttpError(409, prepared.plan.blockers[0]);
        operation = this.repo.transaction(() => {
          if (this.snapshot(sessionId).fingerprint !== prepared.snapshot.fingerprint) throw new AgentHttpError(409, '会话或引用已变化，请重新查看清理影响');
          const op: CleanupOperation = { requestId, sessionId, state: 'deleting_files', plan: prepared.plan, created: Date.now(), files: prepared.candidates.map(blob => ({ digest: blob.digest, state: 'pending', bytes: blob.size })) };
          this.purge(prepared.snapshot, op.created);
          this.repo.db.prepare('INSERT INTO workspace_cleanup_ops VALUES(?,?,?)').run(sessionId, requestId, JSON.stringify(op)); return op;
        });
      }
      if (operation.state === 'completed') return operation;
      for (const file of operation.files.filter(file => file.state === 'pending' || file.state === 'failed')) {
        const referenced = this.repo.db.prepare("SELECT 1 FROM assets WHERE json_extract(data,'$.blobDigest')=? UNION ALL SELECT 1 FROM library_asset_refs WHERE blob_digest=? LIMIT 1").get(file.digest, file.digest);
        if (referenced) { file.state = 'protected'; delete file.error; this.put(operation); continue; }
        try {
          const path = join(this.assets.options.directory, `${file.digest}.blob`); const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) { file.state = 'protected'; }
          else { await this.remove(path); file.state = 'removed'; file.bytes = stat.size; }
          delete file.error;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { file.state = 'missing'; delete file.error; }
          else { file.state = 'failed'; file.error = '媒体副本删除失败，可以重试清理'; }
        }
        this.put(operation);
      }
      if (!operation.files.some(file => file.state === 'pending' || file.state === 'failed')) { operation.state = 'completed'; operation.completed = Date.now(); }
      this.put(operation); return operation;
    });
    this.flights.set(sessionId, flight); void flight.finally(() => this.flights.delete(sessionId)).catch(() => undefined); return flight;
  }
  private put(operation: CleanupOperation) { this.repo.db.prepare('UPDATE workspace_cleanup_ops SET data=? WHERE session_id=?').run(JSON.stringify(operation), operation.sessionId); }
  private purge(snapshot: ReturnType<WorkspaceCleanup['snapshot']>, deletedAt: number) {
    const db = this.repo.db, sid = snapshot.session.id;
    db.exec('CREATE TEMP TABLE cleanup_keep_assets(id TEXT PRIMARY KEY); CREATE TEMP TABLE cleanup_keep_runs(id TEXT PRIMARY KEY); CREATE TEMP TABLE cleanup_keep_drafts(id TEXT PRIMARY KEY); CREATE TEMP TABLE cleanup_keep_revisions(id TEXT PRIMARY KEY); CREATE TEMP TABLE cleanup_keep_tasks(id TEXT PRIMARY KEY);');
    for (const [table, ids] of [['assets', snapshot.keepAssets], ['runs', snapshot.keepRuns], ['drafts', snapshot.keepDrafts], ['revisions', snapshot.keepRevisions], ['tasks', snapshot.keepTasks]] as const) {
      const insert = db.prepare(`INSERT INTO cleanup_keep_${table} VALUES(?)`); for (const id of ids) insert.run(id);
    }
    db.prepare('DELETE FROM receipts WHERE task_id IN (SELECT id FROM tasks WHERE session_id=?)').run(sid);
    for (const table of ['events', 'session_context', 'version_requests', 'versions', 'workspace_requests', 'workspace_request_cancellations', 'workspace_selections', 'legacy_workspace_refs']) db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sid);
    db.prepare('DELETE FROM workspace_operations WHERE session_id=?').run(sid);
    db.prepare('DELETE FROM run_inputs WHERE session_id=? AND run_id NOT IN (SELECT id FROM cleanup_keep_runs)').run(sid);
    db.prepare("DELETE FROM revision_assets WHERE session_id=? AND draft_id || ':' || revision NOT IN (SELECT id FROM cleanup_keep_revisions)").run(sid);
    db.prepare('DELETE FROM asset_upload_requests WHERE session_id=? AND asset_id NOT IN (SELECT id FROM cleanup_keep_assets)').run(sid);
    for (const table of ['asset_locations', 'asset_materializations']) db.prepare(`DELETE FROM ${table} WHERE asset_id IN (SELECT id FROM assets WHERE session_id=? AND id NOT IN (SELECT id FROM cleanup_keep_assets))`).run(sid);
    db.prepare('DELETE FROM assets WHERE session_id=? AND id NOT IN (SELECT id FROM cleanup_keep_assets)').run(sid);
    db.prepare('DELETE FROM runs WHERE session_id=? AND id NOT IN (SELECT id FROM cleanup_keep_runs)').run(sid);
    db.prepare("DELETE FROM draft_revisions WHERE session_id=? AND draft_id || ':' || revision NOT IN (SELECT id FROM cleanup_keep_revisions)").run(sid);
    db.prepare('DELETE FROM drafts WHERE session_id=? AND id NOT IN (SELECT id FROM cleanup_keep_drafts)').run(sid);
    db.prepare('DELETE FROM tasks WHERE session_id=? AND id NOT IN (SELECT id FROM cleanup_keep_tasks)').run(sid);
    for (const task of snapshot.tasks.filter(task => snapshot.keepTasks.has(task.id))) {
      const retained: Task = { id: task.id, sessionId: sid, requestId: task.requestId, state: task.state, created: task.created, deadline: task.deadline, steps: task.steps, previews: task.previews, message: '', messages: [] };
      this.repo.store.update(retained);
    }
    const session = { id: sid, owner: snapshot.session.owner, name: snapshot.session.name, created: snapshot.session.created, schemaVersion: 2, archivedAt: snapshot.session.archivedAt, deletedAt };
    db.prepare('UPDATE workspace_sessions SET data=? WHERE id=?').run(JSON.stringify(session), sid);
    db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify({ ...session, version: 0, workspaceMode: 'draft' }), sid);
    for (const table of ['assets', 'runs', 'drafts', 'revisions', 'tasks']) db.exec(`DROP TABLE cleanup_keep_${table}`);
  }
}
