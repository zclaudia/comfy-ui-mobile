import test from 'node:test';
import assert from 'node:assert/strict';
import { decideAfterReconcile, decideAfterWrite, nameTaken, planSave, saveAvailability, saveTarget, withState } from '../../src/infrastructure/library/librarySaveMachine';
import type { LibrarySaveOp } from '../../src/infrastructure/api/AgentApi';

const server = 'http://c';
const hash = 'a'.repeat(64), other = 'b'.repeat(64);
const source = { serverId: server, workflowId: 'wf-src', filename: '来源.json', name: '来源', etag: 'e-src' };
const last = { serverId: server, workflowId: 'wf-saved', filename: '已存.json', name: '已存', draftVersion: 4, graphHash: hash, etag: 'e-saved', opId: 'op-0', at: 1 };
const op = (state: LibrarySaveOp['state'] = 'pending'): LibrarySaveOp => ({ opId: 'op-1', mode: 'create', draftVersion: 5, graphHash: hash, target: { serverId: server, workflowId: 'wf-new', filename: '新.json', name: '新' }, state, startedBy: 'phone', startedAt: 1, updatedAt: 1 });
const etags = (entries: Array<[string, string | undefined]>) => new Map(entries);

test('saveTarget prefers the last save over the source and ignores other servers', () => {
  assert.equal(saveTarget({ sourceRef: source, lastLibrarySave: last }, server)?.workflowId, 'wf-saved');
  assert.equal(saveTarget({ sourceRef: source }, server)?.workflowId, 'wf-src');
  assert.equal(saveTarget({ sourceRef: source, lastLibrarySave: { ...last, serverId: 'http://elsewhere' } }, server)?.workflowId, 'wf-src');
  assert.equal(saveTarget({ sourceRef: { ...source, serverId: 'http://elsewhere' } }, server), undefined);
  assert.equal(saveTarget({ lastLibrarySave: { ...last, etag: '' } }, server)?.expectedEtag, undefined, 'a legacy save without an etag cannot demand one');
});

test('saveAvailability covers the six panel situations', () => {
  assert.deepEqual(saveAvailability({ session: {}, serverId: server, graphHash: hash, remoteEtags: etags([]) }), { kind: 'create' });
  assert.equal(saveAvailability({ session: { sourceRef: source }, serverId: server, graphHash: hash, remoteEtags: etags([['来源.json', 'e-src']]) }).kind, 'update');
  assert.equal(saveAvailability({ session: { sourceRef: source, lastLibrarySave: last }, serverId: server, graphHash: hash, remoteEtags: etags([['已存.json', 'e-saved']]) }).kind, 'identical');
  assert.equal(saveAvailability({ session: { lastLibrarySave: last }, serverId: server, graphHash: other, remoteEtags: etags([['已存.json', 'e-saved']]) }).kind, 'update');
  const conflict = saveAvailability({ session: { lastLibrarySave: last }, serverId: server, graphHash: hash, remoteEtags: etags([['已存.json', 'e-changed']]) });
  assert.deepEqual(conflict, { kind: 'conflict', target: { serverId: server, workflowId: 'wf-saved', filename: '已存.json', name: '已存', expectedEtag: 'e-saved' }, currentEtag: 'e-changed' });
  assert.equal(saveAvailability({ session: { lastLibrarySave: last }, serverId: server, graphHash: hash, remoteEtags: etags([]) }).kind, 'missing');
  const busy = saveAvailability({ session: { lastLibrarySave: last, librarySaveOp: op('applying') }, serverId: server, graphHash: hash, remoteEtags: etags([['已存.json', 'e-saved']]) });
  assert.equal(busy.kind, 'busy');
  assert.equal(saveAvailability({ session: { librarySaveOp: op('succeeded') }, serverId: server, graphHash: hash, remoteEtags: etags([]) }).kind, 'create', 'a finished operation does not block');
  const untagged = saveAvailability({ session: { sourceRef: { ...source, etag: undefined } }, serverId: server, graphHash: hash, remoteEtags: etags([['来源.json', 'e-now']]) });
  assert.equal(untagged.kind === 'update' && untagged.target.expectedEtag, 'e-now', 'a source without an etag updates against the current server etag');
});

test('planSave fixes the filename and id at creation so retries never mint a second copy', () => {
  const a = planSave({ request: { mode: 'create', name: ' 新/海报 ', workflowId: 'wf-new' }, serverId: server, draftVersion: 5, graphHash: hash, opId: 'op-1', startedBy: 'phone', now: 1 });
  const b = planSave({ request: { mode: 'create', name: ' 新/海报 ', workflowId: 'wf-new' }, serverId: server, draftVersion: 5, graphHash: hash, opId: 'op-1', startedBy: 'phone', now: 1 });
  assert.deepEqual(a, b);
  assert.equal(a.target.filename, '新_海报.json');
  assert.equal(a.target.name, '新/海报');
  assert.equal(a.state, 'pending');
  const update = planSave({ request: { mode: 'update', target: { serverId: server, workflowId: 'wf-src', filename: '来源.json', name: '来源', expectedEtag: 'e-src' } }, serverId: server, draftVersion: 5, graphHash: hash, opId: 'op-2', startedBy: 'phone', now: 1 });
  assert.equal(update.target.expectedEtag, 'e-src');
  assert.equal(update.target.name, '来源');
  assert.equal(nameTaken('新/海报', ['新_海报.json']), true);
  assert.equal(nameTaken('别的', ['新_海报.json']), false);
});

test('decideAfterWrite: success records the save, 409 is a conflict, anything else is reconciled', () => {
  const ok = decideAfterWrite(op('applying'), { success: true, etag: 'e-new' }, 9);
  assert.equal(ok.op.state, 'succeeded');
  assert.deepEqual(ok.lastLibrarySave, { serverId: server, workflowId: 'wf-new', filename: '新.json', name: '新', draftVersion: 5, graphHash: hash, etag: 'e-new', opId: 'op-1', at: 9 });
  const conflict = decideAfterWrite(op('applying'), { success: false, conflict: true }, 9);
  assert.equal(conflict.op.state, 'conflict'); assert.equal(conflict.lastLibrarySave, undefined);
  assert.equal(conflict.op.result?.error, '同名工作流已存在');
  assert.equal(decideAfterWrite({ ...op('applying'), mode: 'update' }, { success: false, conflict: true }, 9).op.result?.error, '工作流已被其他设备修改');
  const unknown = decideAfterWrite(op('applying'), { success: false, error: 'Network Error' }, 9);
  assert.equal(unknown.op.state, 'reconciling'); assert.equal(unknown.op.result?.error, 'Network Error');
  assert.equal(decideAfterWrite(op('applying'), { success: true }, 9).op.state, 'reconciling', 'a success without an etag is read back');
});

test('decideAfterReconcile: only a file carrying this operation id and hash counts as ours', () => {
  const mine = decideAfterReconcile(op('reconciling'), { found: true, saveOpId: 'op-1', graphHash: hash, etag: 'e-back' }, 9);
  assert.equal(mine.op.state, 'succeeded'); assert.equal(mine.lastLibrarySave?.etag, 'e-back');
  assert.equal(decideAfterReconcile(op('reconciling'), { found: true, saveOpId: 'op-9', graphHash: hash, etag: 'e' }, 9).op.state, 'conflict');
  assert.equal(decideAfterReconcile(op('reconciling'), { found: true, saveOpId: 'op-1', graphHash: other, etag: 'e' }, 9).op.state, 'conflict');
  assert.equal(decideAfterReconcile(op('reconciling'), { found: false }, 9).op.state, 'failed');
  assert.equal(decideAfterReconcile({ ...op('reconciling'), mode: 'update' }, { found: false }, 9).op.state, 'conflict');
  assert.equal(withState(op(), 'applying', 3).updatedAt, 3);
});
