import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { Canvas } from '../workflow/canvas.js';
import type { AgentOutput } from './media.js';
import type { WorkspaceTaskState } from './workspace/types.js';
import { canonicalJson } from './workspace/digest.js';

export type State = 'queued' | 'running' | 'waiting_comfy' | 'waiting_user' | 'reconciling' | 'completed' | 'failed' | 'cancelled';
export const activeStates: State[] = ['queued', 'running', 'waiting_comfy', 'waiting_user', 'reconciling'];
const activeSql = activeStates.map(s => `'${s}'`).join(',');
export interface SessionWorkflow { id: string; name: string; filename?: string }
/** Which library workflow a draft started from. A record of origin, not a sync binding: the source may later be renamed or deleted. */
export interface SourceRef { serverId: string; workflowId: string; filename: string; name: string; etag?: string }
/** The last draft version the user explicitly saved into the library, and what the server returned for it. */
export interface LibrarySave { serverId: string; workflowId: string; filename: string; name: string; draftVersion: number; graphHash: string; etag: string; opId: string; at: number }
export type LibrarySaveState = 'pending' | 'applying' | 'reconciling' | 'succeeded' | 'conflict' | 'failed';
export const activeLibrarySaveStates: LibrarySaveState[] = ['pending', 'applying', 'reconciling'];
/**
 * One explicit "save to library" operation. The Gateway keeps the intent and outcome; the App performs the conditional
 * file write against the ComfyUI extension. A client that dies mid-write leaves `applying`, which the next client to open
 * the session reconciles by reading the target file back.
 */
export interface LibrarySaveOp {
  opId: string; mode: 'create' | 'update'; draftVersion: number; graphHash: string;
  target: { serverId: string; workflowId: string; filename: string; name: string; expectedEtag?: string };
  state: LibrarySaveState; startedBy: string; startedAt: number; updatedAt: number; result?: { etag?: string; error?: string };
}
/** `confirm` pauses the task in `waiting_user` before every GPU submission until the App approves or declines it. */
export type PreviewPolicy = 'auto' | 'confirm';
export interface Session {
  id: string; owner: string; name: string; version: number; created: number;
  /** `legacy` sessions predate drafts and still carry the old one-to-one binding in `legacyWorkflow` until a client migrates them. */
  workspaceMode?: 'draft' | 'legacy'; sourceRef?: SourceRef; lastLibrarySave?: LibrarySave; librarySaveOp?: LibrarySaveOp;
  legacyWorkflow?: SessionWorkflow; previewPolicy?: PreviewPolicy;
}
export interface SessionPatch {
  name?: string; sourceRef?: SourceRef | null; lastLibrarySave?: LibrarySave; librarySaveOp?: LibrarySaveOp;
  workspaceMode?: 'draft'; previewPolicy?: PreviewPolicy;
}
/** A submission the model asked for that is held for the user. `decision` is set by the App; the scheduler settles it. */
export interface Approval { callId: string; version: number; requested: number; decision?: 'approved' | 'declined'; decided?: number }
export interface MediaRef { filename: string; subfolder: string; type: string }
/** A file the user uploaded to ComfyUI's input folder before sending a message. */
export interface Attachment extends MediaRef { kind: 'image' | 'video' | 'audio' | 'file'; name?: string; size?: number; width?: number; height?: number }
export interface SessionThumbnail extends MediaRef { kind?: 'image' | 'video' | 'audio' }
export interface SessionSummary extends Session { preview?: string; lastMessage?: string; lastActivity: number; active: boolean; lastState?: State; thumbnail?: SessionThumbnail }
export interface Version { version: number; canvas: Canvas; summary: string; saved: boolean; created: number }
export interface Task {
  id: string; sessionId: string; requestId: string; message: string; attachments?: Attachment[]; state: State;
  created: number; deadline: number; steps: number; previews: number;
  messages: ModelMessage[]; completionChecked?: boolean; awaitingCompletion?: boolean; execution?: { attempt: string; version: number; promptId?: string; submitted: number };
  result?: unknown; error?: string; modelId?: string; contextScale?: number; contextRetried?: boolean;
  approval?: Approval; pausedAt?: number; retries?: number; notBefore?: number;
  workspace?: WorkspaceTaskState;
}
export interface AgentEvent { seq: number; taskId: string | null; kind: string; data: unknown; created: number }
export interface SessionRun { resultSeq: number; taskId: string; version: number; promptId: string; outputs: AgentOutput[] }
/** ComfyUI loader nodes address input files as `subfolder/filename`; keep the text reference in that form. */
export function attachmentPath(attachment: MediaRef) { return attachment.subfolder ? `${attachment.subfolder}/${attachment.filename}` : attachment.filename; }
/** Pixel dimensions let the model check orientation and upscale ratios without seeing the image. */
export function describeDimensions(a: Attachment) {
  if (!a.width || !a.height) return '';
  const shape = a.width === a.height ? 'square' : a.width > a.height ? 'landscape' : 'portrait';
  return ` ${a.width}x${a.height}px ${shape}`;
}
/** Uploaded files are untrusted data: describe them with their ComfyUI input path so the model can wire them into loader nodes. */
export function describeAttachments(text: string, attachments?: Attachment[]) {
  if (!attachments?.length) return text;
  const lines = attachments.map(a => `- ${a.kind} "${attachmentPath(a)}"${a.name && a.name !== a.filename ? ` (original name: ${a.name})` : ''}${describeDimensions(a)}`);
  return `${text}\n\n[User uploaded ${attachments.length} file(s) to the ComfyUI "${attachments[0].type}" folder. Reference them by path in LoadImage.image, LoadAudio.audio or LoadVideo.file, or as create_model_workflow reference assets:\n${lines.join('\n')}]`;
}
export class AgentHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

const librarySaveTransitions: Record<LibrarySaveState, LibrarySaveState[]> = {
  pending: ['applying', 'failed'], applying: ['reconciling', 'succeeded', 'conflict', 'failed'], reconciling: ['succeeded', 'conflict', 'failed'],
  succeeded: [], conflict: [], failed: [],
};
/**
 * A save operation is a small state machine shared by every device that can open the session. A new operation may only
 * start once the previous one has finished; the same operation may only move forward, and its identity fields never change.
 * Re-sending an identical patch is a retry and returns the stored operation unchanged.
 */
function nextLibrarySaveOp(current: LibrarySaveOp | undefined, incoming: LibrarySaveOp): LibrarySaveOp {
  if (!current || current.opId !== incoming.opId) {
    if (current && activeLibrarySaveStates.includes(current.state)) throw new AgentHttpError(409, '另一设备正在保存，请稍后再试');
    if (incoming.state !== 'pending') throw new AgentHttpError(409, '保存操作必须从 pending 开始');
    return incoming;
  }
  if (JSON.stringify(current) === JSON.stringify(incoming)) return current;
  const identity = (op: LibrarySaveOp) => JSON.stringify([op.mode, op.draftVersion, op.graphHash, op.target, op.startedBy, op.startedAt]);
  if (identity(current) !== identity(incoming)) throw new AgentHttpError(409, '保存操作内容与已记录的不一致');
  if (!librarySaveTransitions[current.state].includes(incoming.state)) throw new AgentHttpError(409, `保存操作不能从 ${current.state} 变为 ${incoming.state}`);
  return incoming;
}

/** Single Gateway process. Transactions are short and bounded; GPU/model work never runs inside them. */
export class AgentStore {
  private transactionDepth = 0;
  readonly db: DatabaseSync;
  constructor(path: string, connection?: DatabaseSync) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = connection ?? new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_owner ON sessions(owner);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id));
      CREATE TABLE IF NOT EXISTS versions(session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, version));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS receipts(task_id TEXT NOT NULL, call_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,call_id));
      CREATE TABLE IF NOT EXISTS agent_settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_context(session_id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS version_requests(session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(session_id, request_id));`);
    if (path !== ':memory:') for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }
  setting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM agent_settings WHERE key=?').get(key);
    return row ? JSON.parse(row.data as string) as T : undefined;
  }
  setSetting(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO agent_settings VALUES(?,?)').run(key, JSON.stringify(value));
  }
  context(id: string): { messages: ModelMessage[]; cursor: number } | undefined {
    const row = this.db.prepare('SELECT data FROM session_context WHERE session_id=?').get(id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  saveContext(task: Task) {
    const cursor = Number(this.db.prepare('SELECT MAX(seq) AS seq FROM events WHERE session_id=?').get(task.sessionId)?.seq ?? 0);
    this.db.prepare('INSERT OR REPLACE INTO session_context VALUES(?,?)').run(task.sessionId, JSON.stringify({ messages: task.messages, cursor }));
  }
  // Sessions were once namespaced per device token, so a chat started on the phone was invisible in the browser and a
  // rotated token stranded its history under a namespace no principal could present any more. All authenticated clients
  // are the same person, so adopt those rows into the shared namespace once, in both the column and the stored document.
  // Keep this value in step with SHARED_AGENT_OWNER in gateway/auth.js.
  adoptLegacyDeviceSessions(owner = 'administrator'): number {
    const rows = this.db.prepare("SELECT id, data FROM sessions WHERE owner LIKE 'device:%'").all() as { id: string; data: string }[];
    if (!rows.length) return 0;
    return this.transaction(() => {
      const update = this.db.prepare('UPDATE sessions SET owner=?, data=? WHERE id=?');
      for (const row of rows) {
        const session = { ...JSON.parse(row.data) as Session, owner };
        update.run(owner, JSON.stringify(session), row.id);
      }
      return rows.length;
    });
  }
  // Sessions created before drafts existed bound one library workflow and mirrored every version into it. Mark them so
  // clients stop mirroring and migrate the binding into a source reference; the old field stays as evidence.
  markLegacySessions(): number {
    const rows = this.db.prepare('SELECT id, data FROM sessions').all() as { id: string; data: string }[];
    const update = this.db.prepare('UPDATE sessions SET data=? WHERE id=?');
    return this.transaction(() => {
      let marked = 0;
      for (const row of rows) {
        const session = JSON.parse(row.data) as Session & { workflow?: SessionWorkflow };
        if (session.workspaceMode) continue;
        const { workflow, ...rest } = session;
        update.run(JSON.stringify({ ...rest, workspaceMode: 'legacy', ...(workflow ? { legacyWorkflow: workflow } : {}) }), row.id);
        marked++;
      }
      return marked;
    });
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    // Nested service calls share the outer immediate transaction. A caught
    // inner failure rolls back only its own writes; an outer failure rolls
    // back the complete task/plan/run bundle, including released savepoints.
    const depth = this.transactionDepth;
    const point = `agent_transaction_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = fn(); this.db.exec(depth ? `RELEASE SAVEPOINT ${point}` : 'COMMIT'); return result; }
    catch (error) {
      if (depth) { this.db.exec(`ROLLBACK TO SAVEPOINT ${point}`); this.db.exec(`RELEASE SAVEPOINT ${point}`); }
      else this.db.exec('ROLLBACK');
      throw error;
    } finally { this.transactionDepth--; }
  }
  session(id: string, owner?: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);
    if (!row) throw new AgentHttpError(404, '会话不存在');
    const session = JSON.parse(row.data as string) as Session;
    if (owner !== undefined && session.owner !== owner) throw new AgentHttpError(404, '会话不存在');
    return session;
  }
  list(owner: string): SessionSummary[] {
    const rows = this.db.prepare(`SELECT s.data,
      (SELECT substr(json_extract(e.data,'$.text'),1,100) FROM events e WHERE e.session_id=s.id AND e.kind='user' ORDER BY e.seq LIMIT 1) AS preview,
      (SELECT substr(json_extract(e.data,'$.text'),1,140) FROM events e WHERE e.session_id=s.id AND e.kind IN ('user','assistant') ORDER BY e.seq DESC LIMIT 1) AS last_message,
      (SELECT e.created FROM events e WHERE e.session_id=s.id ORDER BY e.seq DESC LIMIT 1) AS last_activity,
      (SELECT COUNT(*) FROM tasks t WHERE t.session_id=s.id AND t.state IN (${activeSql})) AS active,
      (SELECT t.state FROM tasks t WHERE t.session_id=s.id ORDER BY t.rowid DESC LIMIT 1) AS last_state,
      (SELECT o.value FROM events e, json_each(e.data,'$.outputs') o WHERE e.session_id=s.id AND e.kind='result' AND json_extract(o.value,'$.filename') IS NOT NULL
        ORDER BY e.seq DESC, CASE json_extract(o.value,'$.kind') WHEN 'image' THEN 0 WHEN 'video' THEN 1 ELSE 2 END, o.key LIMIT 1) AS thumbnail
      FROM sessions s WHERE s.owner=? ORDER BY s.rowid DESC LIMIT 100`).all(owner);
    return rows.map(r => {
      const session = JSON.parse(r.data as string) as Session;
      let thumbnail: Partial<SessionThumbnail> | undefined;
      if (r.thumbnail) {
        try { const parsed = JSON.parse(r.thumbnail as string); if (parsed && typeof parsed === 'object' && typeof parsed.filename === 'string') thumbnail = parsed; }
        catch { thumbnail = undefined; }
      }
      return {
        ...session,
        ...(r.preview ? { preview: r.preview as string } : {}),
        ...(r.last_message ? { lastMessage: r.last_message as string } : {}),
        lastActivity: Number(r.last_activity ?? session.created),
        active: Number(r.active) > 0,
        ...(r.last_state ? { lastState: r.last_state as State } : {}),
        ...(thumbnail ? { thumbnail: { filename: String(thumbnail.filename), subfolder: String(thumbnail.subfolder ?? ''), type: String(thumbnail.type ?? 'output'), ...(thumbnail.kind === 'image' || thumbnail.kind === 'video' || thumbnail.kind === 'audio' ? { kind: thumbnail.kind } : {}) } } : {}),
      };
    }).sort((a, b) => b.lastActivity - a.lastActivity);
  }
  create(owner: string, name: string, canvas?: Canvas, sourceRef?: SourceRef): Session {
    return this.transaction(() => {
      const session: Session = { id: randomUUID(), owner, name, version: canvas ? 1 : 0, created: Date.now(), workspaceMode: 'draft', ...(sourceRef ? { sourceRef } : {}) };
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session.id, owner, JSON.stringify(session));
      if (canvas) this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(session.id, 1, JSON.stringify({ version: 1, canvas, summary: '导入工作流副本', saved: false, created: Date.now() }));
      return session;
    });
  }
  updateSession(id: string, patch: SessionPatch): Session {
    return this.transaction(() => {
      const session = this.session(id);
      if (patch.name !== undefined) session.name = patch.name;
      if (patch.sourceRef === null) delete session.sourceRef;
      else if (patch.sourceRef) session.sourceRef = patch.sourceRef;
      if (patch.workspaceMode) session.workspaceMode = patch.workspaceMode;
      if (patch.librarySaveOp) session.librarySaveOp = nextLibrarySaveOp(session.librarySaveOp, patch.librarySaveOp);
      if (patch.lastLibrarySave) {
        const op = session.librarySaveOp;
        // Only a finished operation may claim a library save; `legacy` is the migration path for pre-draft bindings.
        const legacy = patch.lastLibrarySave.opId === 'legacy' && patch.workspaceMode === 'draft';
        if (!legacy && (!op || op.opId !== patch.lastLibrarySave.opId || op.state !== 'succeeded')) throw new AgentHttpError(409, '保存操作尚未成功，不能记录入库结果');
        session.lastLibrarySave = patch.lastLibrarySave;
      }
      if (patch.previewPolicy === 'auto') delete session.previewPolicy;
      else if (patch.previewPolicy) session.previewPolicy = patch.previewPolicy;
      this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), id);
      return session;
    });
  }
  /** Callers must cancel active tasks first (see AgentService.deleteSession); a running task would otherwise hit FK errors. */
  deleteSession(id: string) {
    this.transaction(() => {
      this.session(id);
      this.db.prepare('DELETE FROM receipts WHERE task_id IN (SELECT id FROM tasks WHERE session_id=?)').run(id);
      this.db.prepare('DELETE FROM session_context WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM version_requests WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM events WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM versions WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM tasks WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    });
  }
  version(id: string, version?: number): Version | undefined {
    const current = version ?? this.session(id).version;
    const row = this.db.prepare('SELECT data FROM versions WHERE session_id=? AND version=?').get(id, current);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  versions(id: string): Omit<Version, 'canvas'>[] { return this.versionsPage(id).versions; }
  /** Newest first. `before` excludes that version and everything newer, so a client walks back with the last version it holds. */
  versionsPage(id: string, before?: number, limit = 100): { versions: Omit<Version, 'canvas'>[]; hasMore: boolean } {
    const rows = before === undefined
      ? this.db.prepare('SELECT data FROM versions WHERE session_id=? ORDER BY version DESC LIMIT ?').all(id, limit + 1)
      : this.db.prepare('SELECT data FROM versions WHERE session_id=? AND version<? ORDER BY version DESC LIMIT ?').all(id, before, limit + 1);
    const versions = rows.slice(0, limit).map(r => { const metadata = JSON.parse(r.data as string); delete metadata.canvas; return metadata as Omit<Version, 'canvas'>; });
    return { versions, hasMore: rows.length > limit };
  }
  /** Idempotency for manual version commits: a retry after a lost response must not create a second version. */
  versionRequest(id: string, requestId: string): number | undefined {
    const row = this.db.prepare('SELECT version FROM version_requests WHERE session_id=? AND request_id=?').get(id, requestId);
    return row ? Number(row.version) : undefined;
  }
  recordVersionRequest(id: string, requestId: string, version: number) {
    this.db.prepare('INSERT INTO version_requests VALUES(?,?,?)').run(id, requestId, version);
  }
  // Called inside a transaction together with the tool receipt and event.
  commitVersion(id: string, baseVersion: number, canvas: Canvas, summary: string): Version {
    const session = this.session(id);
    if (session.version !== baseVersion) throw new AgentHttpError(409, '工作流版本已改变，请重新读取');
    const version: Version = { version: baseVersion + 1, canvas, summary, saved: false, created: Date.now() };
    this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(id, version.version, JSON.stringify(version));
    session.version = version.version;
    this.db.prepare('UPDATE sessions SET data=? WHERE id=?').run(JSON.stringify(session), id);
    return version;
  }
  saveVersion(id: string, version: number) {
    const data = this.version(id, version);
    if (!data) throw new AgentHttpError(404, '版本不存在');
    data.saved = true;
    this.db.prepare('UPDATE versions SET data=? WHERE session_id=? AND version=?').run(JSON.stringify(data), id, version);
  }
  task(id: string): Task {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
    if (!row) throw new AgentHttpError(404, '任务不存在');
    return JSON.parse(row.data as string);
  }
  tasks(sessionId?: string): Task[] {
    const rows = sessionId ? this.db.prepare('SELECT data FROM tasks WHERE session_id=? ORDER BY rowid DESC LIMIT 100').all(sessionId)
      : this.db.prepare(`SELECT data FROM tasks WHERE state IN (${activeSql}) ORDER BY rowid`).all();
    return rows.map(r => JSON.parse(r.data as string));
  }
  enqueue(sessionId: string, requestId: string, message: string, durationMs: number, attachments: Attachment[] = [], modelId?: string, workspace?: Pick<WorkspaceTaskState, 'schemaVersion' | 'requestContext' | 'directRun'>): Task {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM tasks WHERE session_id=? AND request_id=?').get(sessionId, requestId);
      if (existing) {
        const task = JSON.parse(existing.data as string) as Task;
        if (task.message !== message || JSON.stringify(task.attachments ?? []) !== JSON.stringify(attachments)
          || canonicalJson(task.workspace ? { schemaVersion: task.workspace.schemaVersion, requestContext: task.workspace.requestContext, ...(task.workspace.directRun ? { directRun: true } : {}) } : null) !== canonicalJson(workspace ?? null)) throw new AgentHttpError(409, '请求 ID 已用于其他消息');
        return task;
      }
      if (this.db.prepare(`SELECT id FROM tasks WHERE session_id=? AND state IN (${activeSql}) LIMIT 1`).get(sessionId)) throw new AgentHttpError(409, '请先等待或停止当前任务');
      if (this.tasks().length >= 20) throw new AgentHttpError(429, '后台任务队列已满');
      const task: Task = { id: randomUUID(), sessionId, requestId, message, ...(attachments.length ? { attachments } : {}), state: 'queued', ...(modelId ? { modelId } : {}), ...(workspace ? { workspace: structuredClone(workspace) } : {}), created: Date.now(), deadline: Date.now() + durationMs, steps: 0, previews: 0, messages: [] };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id, sessionId, requestId, task.state, JSON.stringify(task));
      this.event(sessionId, task.id, 'user', { text: message, ...(attachments.length ? { attachments } : {}), ...(workspace ? { context: workspace.requestContext, ...(workspace.directRun ? { directRun: true } : {}) } : {}) });
      this.event(sessionId, task.id, 'state', { state: 'queued' });
      return task;
    });
  }
  update(task: Task) { this.db.prepare('UPDATE tasks SET state=?,data=? WHERE id=?').run(task.state, JSON.stringify(task), task.id); }
  event(sessionId: string, taskId: string | null, kind: string, data: unknown) {
    this.db.prepare('INSERT INTO events(session_id,task_id,kind,data,created) VALUES(?,?,?,?,?)').run(sessionId, taskId, kind, JSON.stringify(data), Date.now());
  }
  events(id: string, after = 0): AgentEvent[] {
    return this.db.prepare('SELECT seq,task_id,kind,data,created FROM events WHERE session_id=? AND seq>? ORDER BY seq LIMIT 200').all(id, after)
      .map(r => ({ seq: Number(r.seq), taskId: r.task_id as string | null, kind: r.kind as string, data: JSON.parse(r.data as string), created: Number(r.created) }));
  }
  /** Durable execution evidence, independent of model context compaction and the task-list limit. */
  sessionRuns(id: string, before = Number.MAX_SAFE_INTEGER): SessionRun[] {
    return this.db.prepare("SELECT seq,task_id,data FROM events WHERE session_id=? AND kind='result' AND json_extract(data,'$.success')=1 AND seq<? ORDER BY seq DESC LIMIT 10").all(id, before)
      .map(r => ({ ...JSON.parse(r.data as string), resultSeq: Number(r.seq), taskId: r.task_id as string }));
  }
  sessionRun(id: string, resultSeq: number): SessionRun {
    const row = this.db.prepare("SELECT task_id,data FROM events WHERE session_id=? AND seq=? AND kind='result' AND json_extract(data,'$.success')=1").get(id, resultSeq);
    if (!row) throw new AgentHttpError(404, '本对话中找不到该成功生成结果');
    return { ...JSON.parse(row.data as string), resultSeq, taskId: row.task_id as string };
  }
  recentMessages(id: string): ModelMessage[] {
    const context = this.context(id);
    const messages = this.db.prepare("SELECT kind,data FROM events WHERE session_id=? AND seq>? AND kind IN ('user','assistant') ORDER BY seq").all(id, context?.cursor ?? 0)
      .map(r => {
        const data = JSON.parse(r.data as string) as { text?: unknown; attachments?: Attachment[] };
        const text = String(data.text ?? '');
        return { role: r.kind as 'user' | 'assistant', content: r.kind === 'user' ? describeAttachments(text, data.attachments) : text };
      });
    return [...(context?.messages ?? []), ...messages];
  }
  receipt(taskId: string, callId: string): unknown | undefined {
    const row = this.db.prepare('SELECT data FROM receipts WHERE task_id=? AND call_id=?').get(taskId, callId);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  putReceipt(taskId: string, callId: string, result: unknown) {
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(taskId, callId, JSON.stringify(result));
  }
}
