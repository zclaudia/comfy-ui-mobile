import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentStore, AgentHttpError } from '../store.js';
import { WorkspaceRepository } from './repository.js';
import { backupDatabase, migrateLegacyWorkspace, planMigration } from './migration.js';

export function runWorkspaceMigration(args: string[]) {
  const { values } = parseArgs({ args, options: { database: { type: 'string' }, 'server-id': { type: 'string' }, backup: { type: 'string' }, apply: { type: 'boolean', default: false } }, strict: true, allowPositionals: false });
  if (!values.database) throw new AgentHttpError(400, '请提供 --database；默认只盘点，迁移还需要 --apply --backup --server-id');
  const database = resolve(values.database);
  if (!existsSync(database)) throw new AgentHttpError(404, '数据库不存在；不会创建空库代替旧数据');
  if (!values.apply) {
    const db = new DatabaseSync(database, { readOnly: true });
    try { return { mode: 'plan', database, ...planMigration(db) }; } finally { db.close(); }
  }
  if (!values.backup || !values['server-id']?.trim()) throw new AgentHttpError(400, '执行迁移需要 --backup 和原服务器的 --server-id；先停止 Gateway 接收任务');
  const backup = resolve(values.backup);
  const db = new DatabaseSync(database);
  let store: AgentStore | undefined;
  try {
    // Acquire and retain the database lock across the backup and migration. A live gateway connection must be stopped first.
    db.exec('PRAGMA busy_timeout=1000; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    const plan = planMigration(db);
    if (plan.alreadyMigrated) return { mode: 'apply', database, ...plan };
    if (plan.activeTaskIds.length || plan.activeLibrarySaveSessionIds.length) throw new AgentHttpError(409, '仍有活动任务或入库操作；请先恢复 Gateway 并完成或明确停止这些操作');
    backupDatabase(db, backup);
    store = new AgentStore(database, db);
    const report = migrateLegacyWorkspace(new WorkspaceRepository(store), values['server-id'].trim());
    return { mode: 'apply', database, backup, ...report };
  } finally { if (store) store.close(); else db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(runWorkspaceMigration(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : '迁移失败；数据库未确认迁移成功，请检查备份和停止状态'}\n`); process.exitCode = 1; }
}
