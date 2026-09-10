import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentStore } from '../store.js';
import { AgentService } from '../service.js';
import { createModelWorkflow } from '../modelProfiles.js';
import { WorkspaceRepository } from '../workspace/repository.js';
import { runWorkspaceMigration } from '../workspace/migrateCli.js';

test('migration CLI plans read-only, backs up before changing schema, and enforces the runtime version gate', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-cli-'));
  const database = join(directory, 'old.sqlite'); const backup = join(directory, 'backup.sqlite');
  const info = JSON.parse(readFileSync(new URL('./model-fixtures/object-info.json', import.meta.url), 'utf8'));
  const store = new AgentStore(database);
  const session = store.create('owner', 'image', createModelWorkflow(info, { profileId: 'z-image-turbo', text: 'cat' }));
  const task = store.enqueue(session.id, randomUUID(), 'hello', 60_000); store.update({ ...task, state: 'completed' }); store.close();
  const original = readFileSync(database);
  try {
    const plan = runWorkspaceMigration(['--database', database]); assert.equal(plan.mode, 'plan'); assert.equal(plan.revisions, 1);
    assert.deepEqual(readFileSync(database), original, 'planning does not mutate the source file');
    assert.throws(() => new AgentService({ agentStorePath: database, comfyUrl: 'http://unused.invalid', agentWorkspace: { directory: join(directory, 'assets'), serverId: 'server' } }), /显式数据库迁移/);
    const report = runWorkspaceMigration(['--database', database, '--apply', '--backup', backup, '--server-id', 'server']);
    assert.equal(report.mode, 'apply'); assert.ok('drafts' in report && report.drafts === 1);
    const before = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal(before.prepare("SELECT name FROM sqlite_master WHERE name='workspace_sessions'").get(), undefined);
      assert.equal(before.prepare('SELECT COUNT(*) AS n FROM versions').get()!.n, 1);
    } finally { before.close(); }
    assert.throws(() => new AgentService({ agentStorePath: database, comfyUrl: 'http://unused.invalid' }), /旧会话写入模式/);
    const service = new AgentService({ agentStorePath: database, comfyUrl: 'http://unused.invalid', agentWorkspace: { directory: join(directory, 'assets'), serverId: 'server' } });
    try { assert.equal(service.workspace!.repository.drafts(session.id).items.length, 1); } finally { await service.stop(); }
    assert.equal(runWorkspaceMigration(['--database', database, '--apply', '--backup', backup, '--server-id', 'server']).alreadyMigrated, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('migration CLI refuses active work, missing databases and overwrite of a backup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-cli-blocked-'));
  const database = join(directory, 'old.sqlite'); const backup = join(directory, 'backup.sqlite');
  const store = new AgentStore(database); const session = store.create('owner', 'active');
  const task = store.enqueue(session.id, randomUUID(), 'running', 60_000); store.close();
  try {
    assert.throws(() => runWorkspaceMigration(['--database', database, '--apply', '--backup', backup, '--server-id', 'server']), /活动任务/);
    assert.throws(() => runWorkspaceMigration(['--database', join(directory, 'missing.sqlite')]), /不存在/);
    assert.throws(() => runWorkspaceMigration(['--database', database, '--apply']), /需要/);
    const stopped = new AgentStore(database); stopped.update({ ...stopped.task(task.id), state: 'cancelled' }); stopped.close();
    const placeholder = new DatabaseSync(backup); placeholder.close();
    assert.throws(() => runWorkspaceMigration(['--database', database, '--apply', '--backup', backup, '--server-id', 'server']), /不会覆盖/);
    const unchanged = new AgentStore(database);
    try { assert.equal(new WorkspaceRepository(unchanged).db.prepare('SELECT COUNT(*) AS n FROM workspace_migrations').get()!.n, 0); } finally { unchanged.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('migration CLI cannot migrate while another connection holds a database snapshot', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-cli-locked-'));
  const database = join(directory, 'old.sqlite'); const backup = join(directory, 'backup.sqlite');
  const store = new AgentStore(database); store.create('owner', 'idle');
  store.db.exec('BEGIN'); store.db.prepare('SELECT * FROM sessions').all();
  try {
    assert.throws(() => runWorkspaceMigration(['--database', database, '--apply', '--backup', backup, '--server-id', 'server']), /locked|busy/i);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='workspace_sessions'").get(), undefined);
  } finally { store.db.exec('ROLLBACK'); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
