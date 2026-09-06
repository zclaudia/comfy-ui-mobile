import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { Canvas } from '../workflow/canvas.js';

export type State = 'queued' | 'running' | 'waiting_comfy' | 'reconciling' | 'completed' | 'failed' | 'cancelled';
export const activeStates: State[] = ['queued', 'running', 'waiting_comfy', 'reconciling'];
export interface Session { id: string; owner: string; name: string; version: number; created: number }
export interface Version { version: number; canvas: Canvas; summary: string; saved: boolean; created: number }
export interface Task {
  id: string; sessionId: string; requestId: string; message: string; state: State;
  created: number; deadline: number; steps: number; previews: number;
  messages: ModelMessage[]; completionChecked?: boolean; execution?: { attempt: string; version: number; promptId?: string; submitted: number };
  result?: unknown; error?: string;
}
export interface AgentEvent { seq: number; taskId: string | null; kind: string; data: unknown; created: number }
export class AgentHttpError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Single Gateway process. Transactions are short and bounded; GPU/model work never runs inside them. */
export class AgentStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_owner ON sessions(owner);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session_id, request_id));
      CREATE TABLE IF NOT EXISTS versions(session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, version));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), task_id TEXT, kind TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS event_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS receipts(task_id TEXT NOT NULL, call_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(task_id,call_id));`);
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  session(id: string, owner?: string): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);
    if (!row) throw new AgentHttpError(404, '会话不存在');
    const session = JSON.parse(row.data as string) as Session;
    if (owner !== undefined && session.owner !== owner) throw new AgentHttpError(404, '会话不存在');
    return session;
  }
  list(owner: string): (Session & { preview?: string })[] {
    return this.db.prepare(`SELECT s.data, (SELECT substr(json_extract(e.data, '$.text'), 1, 100) FROM events e WHERE e.session_id=s.id AND e.kind='user' ORDER BY e.seq LIMIT 1) AS preview FROM sessions s WHERE s.owner=? ORDER BY s.rowid DESC LIMIT 100`).all(owner)
      .map(r => ({ ...JSON.parse(r.data as string), ...(r.preview ? { preview: r.preview as string } : {}) }));
  }
  create(owner: string, name: string, canvas?: Canvas): Session {
    return this.transaction(() => {
      const session: Session = { id: randomUUID(), owner, name, version: canvas ? 1 : 0, created: Date.now() };
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(session.id, owner, JSON.stringify(session));
      if (canvas) this.db.prepare('INSERT INTO versions VALUES(?,?,?)').run(session.id, 1, JSON.stringify({ version: 1, canvas, summary: '导入工作流副本', saved: false, created: Date.now() }));
      return session;
    });
  }
  version(id: string, version?: number): Version | undefined {
    const current = version ?? this.session(id).version;
    const row = this.db.prepare('SELECT data FROM versions WHERE session_id=? AND version=?').get(id, current);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  versions(id: string): Omit<Version, 'canvas'>[] {
    return this.db.prepare('SELECT data FROM versions WHERE session_id=? ORDER BY version DESC LIMIT 100').all(id).map(r => { const { canvas: _, ...metadata } = JSON.parse(r.data as string); return metadata; });
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
      : this.db.prepare("SELECT data FROM tasks WHERE state IN ('queued','running','waiting_comfy','reconciling') ORDER BY rowid").all();
    return rows.map(r => JSON.parse(r.data as string));
  }
  enqueue(sessionId: string, requestId: string, message: string, durationMs: number): Task {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT data FROM tasks WHERE session_id=? AND request_id=?').get(sessionId, requestId);
      if (existing) {
        const task = JSON.parse(existing.data as string) as Task;
        if (task.message !== message) throw new AgentHttpError(409, '请求 ID 已用于其他消息');
        return task;
      }
      if (this.tasks(sessionId).some(t => activeStates.includes(t.state))) throw new AgentHttpError(409, '请先等待或停止当前任务');
      if (this.tasks().length >= 20) throw new AgentHttpError(429, '后台任务队列已满');
      const task: Task = { id: randomUUID(), sessionId, requestId, message, state: 'queued', created: Date.now(), deadline: Date.now() + durationMs, steps: 0, previews: 0, messages: [] };
      this.db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)').run(task.id, sessionId, requestId, task.state, JSON.stringify(task));
      this.event(sessionId, task.id, 'user', { text: message });
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
  recentMessages(id: string): { role: 'user' | 'assistant'; content: string }[] {
    return this.db.prepare("SELECT kind,data FROM events WHERE session_id=? AND kind IN ('user','assistant') ORDER BY seq DESC LIMIT 20").all(id).reverse()
      .map(r => ({ role: r.kind as 'user' | 'assistant', content: String(JSON.parse(r.data as string).text).slice(0, 8000) }));
  }
  receipt(taskId: string, callId: string): unknown | undefined {
    const row = this.db.prepare('SELECT data FROM receipts WHERE task_id=? AND call_id=?').get(taskId, callId);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  putReceipt(taskId: string, callId: string, result: unknown) {
    this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(taskId, callId, JSON.stringify(result));
  }
}
