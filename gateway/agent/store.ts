import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { WorkspaceTaskState } from './workspace/types.js';
import { canonicalJson } from './workspace/digest.js';

export type State = 'queued' | 'running' | 'waiting_comfy' | 'waiting_user' | 'reconciling' | 'completed' | 'failed' | 'cancelled';
export const activeStates: State[] = ['queued', 'running', 'waiting_comfy', 'waiting_user', 'reconciling'];
const activeSql = activeStates.map(s => `'${s}'`).join(',');
/** Which library workflow a draft started from. A record of origin, not a sync binding: the source may later be renamed or deleted. */
export interface SourceRef { serverId: string; workflowId: string; filename: string; name: string; etag?: string }
export type LibrarySaveState = 'pending' | 'applying' | 'reconciling' | 'succeeded' | 'conflict' | 'failed';
/** `confirm` pauses the task in `waiting_user` before every GPU submission until the App approves or declines it. */
export type PreviewPolicy = 'auto' | 'confirm';
/** The row every session keeps in `sessions`; the multi-draft record lives in `workspace_sessions`. */
export interface Session {
  id: string; owner: string; name: string; version: number; created: number;
  workspaceMode?: 'draft'; sourceRef?: SourceRef; previewPolicy?: PreviewPolicy;
}
export interface MediaRef { filename: string; subfolder: string; type: string }
/** A file uploaded to ComfyUI's input folder and registered as a workspace asset. */
export interface Attachment extends MediaRef { kind: 'image' | 'video' | 'audio' | 'file'; name?: string; size?: number; width?: number; height?: number }
export interface Task {
  id: string; sessionId: string; requestId: string; message: string; state: State;
  created: number; deadline: number; steps: number; previews: number;
  messages: ModelMessage[]; completionChecked?: boolean; awaitingCompletion?: boolean;
  result?: unknown; error?: string; modelId?: string; contextScale?: number; contextRetried?: boolean;
  pausedAt?: number; retries?: number; notBefore?: number;
  workspace?: WorkspaceTaskState;
}
export interface AgentEvent { seq: number; taskId: string | null; kind: string; data: unknown; created: number }
/** ComfyUI loader nodes address input files as `subfolder/filename`; keep the text reference in that form. */
export function attachmentPath(attachment: MediaRef) { return attachment.subfolder ? `${attachment.subfolder}/${attachment.filename}` : attachment.filename; }
export class AgentHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
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
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS agent_settings(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_context(session_id TEXT PRIMARY KEY REFERENCES sessions(id), data TEXT NOT NULL);
`);
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
  enqueue(sessionId: string, requestId: string, message: string, durationMs: number, modelId?: string, workspace?: Pick<WorkspaceTaskState, 'schemaVersion' | 'requestContext' | 'directRun'>): Task {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM tasks WHERE session_id=? AND request_id=?').get(sessionId, requestId);
      if (existing) {
        const task = JSON.parse(existing.data as string) as Task;
        if (task.message !== message
          || canonicalJson(task.workspace ? { schemaVersion: task.workspace.schemaVersion, requestContext: task.workspace.requestContext, ...(task.workspace.directRun ? { directRun: true } : {}) } : null) !== canonicalJson(workspace ?? null)) throw new AgentHttpError(409, '请求 ID 已用于其他消息');
        return task;
      }
      if (this.db.prepare(`SELECT id FROM tasks WHERE session_id=? AND state IN (${activeSql}) LIMIT 1`).get(sessionId)) throw new AgentHttpError(409, '请先等待或停止当前任务');
      if (this.tasks().length >= 20) throw new AgentHttpError(429, '后台任务队列已满');
      const task: Task = { id: randomUUID(), sessionId, requestId, message, state: 'queued', ...(modelId ? { modelId } : {}), ...(workspace ? { workspace: structuredClone(workspace) } : {}), created: Date.now(), deadline: Date.now() + durationMs, steps: 0, previews: 0, messages: [] };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id, sessionId, requestId, task.state, JSON.stringify(task));
      this.event(sessionId, task.id, 'user', { text: message, ...(workspace ? { context: workspace.requestContext, ...(workspace.directRun ? { directRun: true } : {}) } : {}) });
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
  recentMessages(id: string): ModelMessage[] {
    const context = this.context(id);
    const messages = this.db.prepare("SELECT kind,data FROM events WHERE session_id=? AND seq>? AND kind IN ('user','assistant') ORDER BY seq").all(id, context?.cursor ?? 0)
      .map(r => {
        const data = JSON.parse(r.data as string) as { text?: unknown };
        return { role: r.kind as 'user' | 'assistant', content: String(data.text ?? '') };
      });
    return [...(context?.messages ?? []), ...messages];
  }
}
