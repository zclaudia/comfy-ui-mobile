import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceLibrarySaveService } from '../../src/infrastructure/library/WorkspaceLibrarySaveService';
import type { WorkspaceLibraryOperation } from '../../src/shared/types/agentWorkspace';

function fixture(mode: 'create' | 'update' = 'create') {
  let op: WorkspaceLibraryOperation = { id: 'op', sessionId: 'session', draftId: 'draft', revision: 2, revisionDigest: 'logical', requestDigest: 'request',
    mode, state: 'applying', target: { serverId: 'server', workflowId: 'workflow', filename: 'file.json', name: 'file', ...(mode === 'update' ? { expectedEtag: 'old' } : {}) },
    startedBy: 'device', created: 1, updated: 1, content: { nodes: [], links: [], version: 0.4 } as WorkspaceLibraryOperation['content'], contentDigest: 'fixed' };
  let saved = false; let failRead = false; let lostWrite = false; let claimedSuccess = false;
  const writes: { filename: string; content: unknown; options: unknown }[] = [];
  const service = new WorkspaceLibrarySaveService({ serverId: 'server', api: {
    librarySave: async () => ({ operation: structuredClone(op) }),
    librarySaveAction: async (_session, _id, action) => {
      if (action === 'reconcile') {
        if (failRead) throw new Error('network unavailable');
        op = { ...op, state: saved ? 'succeeded' : 'reconciling', ...(saved ? { result: { etag: 'verified' } } : {}) };
      }
      return { operation: structuredClone(op) };
    },
  }, files: { saveWorkflow: async (filename, content, options) => {
    writes.push({ filename, content, options });
    if (!claimedSuccess) saved = true;
    if (lostWrite) throw new Error('response lost');
    return { success: true, etag: 'unverified-client-reply' };
  } } });
  return { service, writes, op, setSaved: () => { saved = true; }, setOffline: () => { failRead = true; }, setLost: () => { lostWrite = true; }, setFakeSuccess: () => { claimedSuccess = true; } };
}

test('client resumes the fixed update with the original ETag and accepts only the Gateway verified outcome', async () => {
  const f = fixture('update'); f.setLost();
  const result = await f.service.resume('session', 'op', true);
  assert.equal(result.state, 'succeeded'); assert.equal(result.result!.etag, 'verified');
  assert.deepEqual(f.writes, [{ filename: 'file.json', content: f.op.content, options: { expectedEtag: 'old' } }]);
});
test('recovered successful write and check-only actions never submit another file write', async () => {
  const f = fixture(); f.setSaved();
  assert.equal((await f.service.resume('session', 'op', true)).state, 'succeeded'); assert.equal(f.writes.length, 0);
  const g = fixture();
  assert.equal((await g.service.resume('session', 'op', false)).state, 'reconciling'); assert.equal(g.writes.length, 0);
});
test('unavailable read-back blocks retries; a client success response cannot mark an unobserved file saved', async () => {
  const f = fixture(); f.setOffline();
  await assert.rejects(f.service.resume('session', 'op', true), /network/); assert.equal(f.writes.length, 0);
  const g = fixture(); g.setFakeSuccess();
  assert.equal((await g.service.resume('session', 'op', true)).state, 'reconciling');
  assert.deepEqual(g.writes[0].options, { overwrite: false });
});
