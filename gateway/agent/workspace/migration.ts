import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Canvas } from '../../workflow/canvas.js';
import { AgentHttpError, activeLibrarySaveStates, activeStates } from '../store.js';
import type { Attachment, Session, Task, Version } from '../store.js';
import { digest } from './digest.js';
import { WorkspaceRepository } from './repository.js';
import type { Asset, Draft, MediaKind, Revision, Run } from './types.js';
import { WORKSPACE_SCHEMA_VERSION } from './types.js';

interface EventRow { seq: number; task_id: string | null; kind: string; data: string; created: number }
interface LegacyResult { version?: number; promptId?: string; state?: string; success?: boolean; outputs?: Attachment[]; diagnostic?: unknown; attempt?: string }
export interface MigrationPlan {
  version: number; alreadyMigrated: boolean; sessions: number; revisions: number; tasks: number; events: number;
  activeTaskIds: string[]; activeLibrarySaveSessionIds: string[]; unresolvedTerminalExecutionIds: string[];
}
export interface MigrationReport extends MigrationPlan {
  drafts: number; runs: number; assets: number; incompleteEventSeqs: number[]; completed: number;
}

/** Namespaced deterministic UUIDs keep legacy links stable even when migration is rebuilt from a backup. */
export function migrationId(...parts: (string | number)[]) {
  const bytes = createHash('sha256').update(JSON.stringify(['comfy-mobile-workspace-v2', ...parts])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function planMigration(db: DatabaseSync): MigrationPlan {
  const hasTable = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_migrations'").get();
  const prior = hasTable ? db.prepare('SELECT version FROM workspace_migrations WHERE version=?').get(WORKSPACE_SCHEMA_VERSION) : undefined;
  const tasks = (db.prepare('SELECT data FROM tasks').all() as { data: string }[]).map(row => JSON.parse(row.data) as Task);
  const sessions = (db.prepare('SELECT data FROM sessions').all() as { data: string }[]).map(row => JSON.parse(row.data) as Session);
  const count = (table: 'versions' | 'events') => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
  return { version: WORKSPACE_SCHEMA_VERSION, alreadyMigrated: !!prior, sessions: sessions.length, revisions: count('versions'), tasks: tasks.length, events: count('events'),
    activeTaskIds: tasks.filter(task => activeStates.includes(task.state)).map(task => task.id),
    activeLibrarySaveSessionIds: sessions.filter(session => session.librarySaveOp && activeLibrarySaveStates.includes(session.librarySaveOp.state)).map(session => session.id),
    unresolvedTerminalExecutionIds: tasks.filter(task => !activeStates.includes(task.state) && task.execution && !task.result).map(task => task.id) };
}

/** SQLite creates a consistent standalone copy including committed WAL contents; never copy just the main DB file. */
export function backupDatabase(db: DatabaseSync, destination: string) {
  if (existsSync(destination)) throw new AgentHttpError(409, '迁移备份文件已存在，不会覆盖');
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  db.prepare('VACUUM INTO ?').run(destination);
  chmodSync(destination, 0o600);
}

function outputKinds(canvas: Canvas): MediaKind[] {
  const kinds = new Set<MediaKind>();
  for (const node of canvas.nodes) {
    if (/SaveImage|PreviewImage/.test(node.type)) kinds.add('image');
    if (/SaveVideo|VideoCombine/.test(node.type)) kinds.add('video');
    if (/SaveAudio|PreviewAudio/.test(node.type)) kinds.add('audio');
  }
  return [...kinds];
}

/** Caller has stopped new task admission and backed up the database. No network or media IO runs in this transaction. */
export function migrateLegacyWorkspace(repository: WorkspaceRepository, serverId: string): MigrationReport {
  if (!serverId) throw new AgentHttpError(400, '迁移需要记录原 ComfyUI 服务器身份');
  const { db, store } = repository;
  return repository.transaction(() => {
    const previous = db.prepare('SELECT report FROM workspace_migrations WHERE version=?').get(WORKSPACE_SCHEMA_VERSION);
    if (previous) return { ...JSON.parse(String(previous.report)) as MigrationReport, alreadyMigrated: true };
    const plan = planMigration(db);
    if (plan.activeTaskIds.length || plan.activeLibrarySaveSessionIds.length) throw new AgentHttpError(409, '仍有活动任务或入库操作，请先停止接收新任务并等待操作结束');
    const report: MigrationReport = { ...plan, drafts: 0, runs: 0, assets: 0, incompleteEventSeqs: [], completed: Date.now() };
    const map = (sessionId: string, kind: string, key: string, value: unknown) => db.prepare('INSERT INTO legacy_workspace_refs VALUES(?,?,?,?)').run(sessionId, kind, key, JSON.stringify(value));
    const sessions = db.prepare('SELECT id,data FROM sessions ORDER BY rowid').all() as { id: string; data: string }[];
    for (const row of sessions) {
      const session = JSON.parse(row.data) as Session;
      const workspace = repository.initializeSession(session.id);
      const versions = (db.prepare('SELECT data FROM versions WHERE session_id=? ORDER BY version').all(session.id) as { data: string }[]).map(row => JSON.parse(row.data) as Version);
      const draftId = migrationId(session.id, 'draft');
      if (versions.length) {
        if (versions.at(-1)!.version !== session.version) throw new AgentHttpError(422, '旧会话的当前版本与版本记录不一致，请先修复数据');
        const draft: Draft = { id: draftId, sessionId: session.id, name: session.sourceRef?.name ?? session.name, headRevision: session.version,
          outputKinds: [...new Set(versions.flatMap(v => outputKinds(v.canvas)))], created: session.created, updated: versions.at(-1)!.created, legacy: true,
          ...(session.sourceRef ? { sourceRef: session.sourceRef } : {}) };
        const save = session.lastLibrarySave;
        if (save && versions.some(version => version.version === save.draftVersion)) {
          const saved = versions.find(version => version.version === save.draftVersion)!;
          draft.lastLibrarySave = { ...save, draftId, revision: save.draftVersion, revisionDigest: digest({ nodes: saved.canvas.nodes, links: saved.canvas.links, bindings: [] }), exportGraphHash: save.graphHash };
        }
        db.prepare('INSERT INTO drafts(id,session_id,head_revision,data) VALUES(?,?,?,?)').run(draft.id, session.id, draft.headRevision, JSON.stringify(draft));
        for (const [index, version] of versions.entries()) {
          const revision: Revision = { draftId, sessionId: session.id, revision: version.version, canvas: version.canvas, bindings: [],
            summary: version.summary, created: version.created, retained: version.saved, digest: digest({ nodes: version.canvas.nodes, links: version.canvas.links, bindings: [] }),
            ...(index ? { previousHeadRevision: versions[index - 1].version } : {}) };
          // Old history does not record edit parents reliably. Preserve chronology without inventing a sourceRevision.
          db.prepare('INSERT INTO draft_revisions VALUES(?,?,?,?)').run(draftId, revision.revision, session.id, JSON.stringify(revision));
          map(session.id, 'version', String(version.version), { draftId, revision: revision.revision });
        }
        workspace.defaultContext = { targetDraftId: draftId };
        db.prepare('UPDATE workspace_sessions SET data=? WHERE id=?').run(JSON.stringify(workspace), session.id);
        report.drafts++;
      } else if (session.version) throw new AgentHttpError(422, '旧会话缺少工作流版本，不能完成迁移');
      // Keep every original library record, even when its target revision no longer exists.
      if (session.lastLibrarySave || session.librarySaveOp || session.legacyWorkflow) map(session.id, 'library', 'session', { lastLibrarySave: session.lastLibrarySave, librarySaveOp: session.librarySaveOp, legacyWorkflow: session.legacyWorkflow });

      const tasks = (db.prepare('SELECT data FROM tasks WHERE session_id=?').all(session.id) as { data: string }[]).map(row => JSON.parse(row.data) as Task);
      const taskMap = new Map(tasks.map(task => [task.id, task]));
      const events = db.prepare('SELECT seq,task_id,kind,data,created FROM events WHERE session_id=? ORDER BY seq').all(session.id) as unknown as EventRow[];
      const runs = new Map<string, Run>();
      const outputEvents = new Map<string, { event: EventRow; output: Attachment; index: number }[]>();
      for (const event of events) {
        if (!['state', 'result', 'execution_error'].includes(event.kind)) continue;
        const data = JSON.parse(event.data) as LegacyResult;
        if (!data || typeof data !== 'object') continue;
        if (typeof data.promptId !== 'string' || !data.promptId || !Number.isSafeInteger(data.version) || !versions.some(version => version.version === data.version)) {
          if (event.kind === 'result' || event.kind === 'execution_error') report.incompleteEventSeqs.push(event.seq);
          continue;
        }
        const knownTask = event.task_id ? taskMap.get(event.task_id) : undefined;
        const key = JSON.stringify([event.task_id, data.promptId, data.version]);
        let run = runs.get(key);
        if (!run) {
          const execution = knownTask?.execution;
          const attempt = execution?.promptId === data.promptId && execution.version === data.version ? execution.attempt : data.attempt;
          run = { id: migrationId(session.id, 'run', key), sessionId: session.id, ...(knownTask ? { taskId: knownTask.id } : {}), draftId, revision: data.version!,
            serverId, state: 'unknown', submissionKey: attempt ?? migrationId(session.id, 'submission', key), promptId: data.promptId,
            inputManifest: [], outputAssetIds: [], created: event.created,
            legacy: { incomplete: true, eventSeqs: [], ...(attempt ? { attemptId: attempt } : {}) } };
          runs.set(key, run);
        }
        run.legacy!.eventSeqs.push(event.seq);
        if (event.kind === 'result' && data.success === true) {
          run.state = 'succeeded'; run.completed = event.created;
          // Earlier collection discarded node location and excess outputs. Do not invent their original positions.
          if (!outputEvents.has(run.id)) outputEvents.set(run.id, (Array.isArray(data.outputs) ? data.outputs : []).map((output, index) => ({ event, output, index })));
        } else if (event.kind === 'execution_error' && data.success === false) {
          run.state = 'failed'; run.completed = event.created; run.diagnostic = data.diagnostic;
        }
        if (event.kind === 'state') run.submitted ??= event.created;
        map(session.id, 'run_event', String(event.seq), { runId: run.id, draftId, revision: run.revision });
      }
      for (const task of tasks) {
        const execution = task.execution;
        if (!execution || !versions.some(v => v.version === execution.version)) continue;
        if ([...runs.values()].some(run => run.taskId === task.id && (run.submissionKey === execution.attempt || (execution.promptId && run.promptId === execution.promptId)))) continue;
        const key = JSON.stringify([task.id, execution.attempt]);
        runs.set(key, { id: migrationId(session.id, 'run', key), sessionId: session.id, taskId: task.id, draftId, revision: execution.version, serverId,
          state: 'unknown', submissionKey: execution.attempt, ...(execution.promptId ? { promptId: execution.promptId } : {}),
          inputManifest: [], outputAssetIds: [], created: execution.submitted, submitted: execution.submitted,
          legacy: { incomplete: true, eventSeqs: [], attemptId: execution.attempt } });
      }
      for (const run of runs.values()) {
        repository.insertRun(run); report.runs++;
        const ordinals: Partial<Record<MediaKind, number>> = {};
        for (const { event, output, index } of outputEvents.get(run.id) ?? []) {
          if (!output || !['image', 'video', 'audio'].includes(output.kind) || typeof output.filename !== 'string') { report.incompleteEventSeqs.push(event.seq); continue; }
          const id = migrationId(session.id, 'asset', event.seq, index);
          const asset: Asset = { id, sessionId: session.id, name: output.filename, kind: output.kind, origin: 'generated', sourceRunId: run.id,
            outputLocator: `legacy:${event.seq}:${index}`, displayOrdinal: ordinals[output.kind] = (ordinals[output.kind] ?? 0) + 1,
            captureState: 'pending_capture', metadata: {}, created: event.created, legacy: { resultSeq: event.seq, outputIndex: index, unverified: true } };
          repository.registerAsset(asset, { id: migrationId(id, 'source'), assetId: id, serverId, role: 'source', ref: { filename: output.filename, subfolder: output.subfolder ?? '', type: output.type ?? 'output' } });
          map(session.id, 'asset', `${event.seq}:${index}`, { assetId: id });
          if (run.taskId) {
            const receipt = store.receipt(run.taskId, `output-image:${event.seq}:${index}`) as { filename?: string; subfolder?: string; type?: string } | undefined;
            if (receipt?.filename && receipt.type === 'input') repository.putLocation({ id: migrationId(id, 'legacy-input'), assetId: id, serverId, role: 'input', ref: { filename: receipt.filename, subfolder: receipt.subfolder ?? '', type: 'input' } });
          }
          run.outputAssetIds.push(id); report.assets++;
        }
        db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(run), run.id);
      }
      for (const event of events.filter(e => e.kind === 'user')) {
        const data = JSON.parse(event.data) as { attachments?: Attachment[] };
        if (!Array.isArray(data?.attachments)) continue;
        for (const [index, attachment] of data.attachments.entries()) {
          if (!attachment || typeof attachment.filename !== 'string') continue;
          const id = migrationId(session.id, 'upload', event.seq, index);
          const asset: Asset = { id, sessionId: session.id, name: attachment.name ?? attachment.filename, kind: attachment.kind, origin: 'uploaded',
            sourceMessageSeq: event.seq, displayOrdinal: index + 1, captureState: 'pending_capture',
            metadata: { size: attachment.size, width: attachment.width, height: attachment.height }, created: event.created, legacy: { unverified: true } };
          repository.registerAsset(asset, { id: migrationId(id, 'source'), assetId: id, serverId, role: 'source', ref: { filename: attachment.filename, subfolder: attachment.subfolder ?? '', type: attachment.type ?? 'input' } });
          map(session.id, 'attachment', `${event.seq}:${index}`, { assetId: id }); report.assets++;
        }
      }
    }
    db.prepare('INSERT INTO workspace_migrations VALUES(?,?,?)').run(WORKSPACE_SCHEMA_VERSION, report.completed, JSON.stringify(report));
    return report;
  });
}
