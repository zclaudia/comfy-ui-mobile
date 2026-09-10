import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DraftCopyConflict, DraftWorkingCopy, draftCopyKey } from '../../src/infrastructure/storage/DraftWorkingCopy';
import type { DraftContent, DraftCopyRecord, DraftCopyStore, DraftSaveRequest } from '../../src/infrastructure/storage/DraftWorkingCopy';
import { importDraftRecovery, inspectDraftRecovery, parseDraftRecovery } from '../../src/infrastructure/storage/DraftRecoveryImport';
import type { DraftRecoveryDocument } from '../../src/infrastructure/storage/DraftRecoveryImport';
import type { Draft, Revision, AssetDetail } from '../../src/shared/types/agentWorkspace';

class MemoryCopies implements DraftCopyStore {
  records = new Map<string, DraftCopyRecord>(); fail = false;
  async read(key: string) { return structuredClone(this.records.get(key)); }
  async compareAndSwap(key: string, epoch: number | undefined, next: DraftCopyRecord) {
    if (this.fail) throw new Error('Disk full');
    if (this.records.get(key)?.epoch !== epoch) throw new DraftCopyConflict();
    this.records.set(key, structuredClone(next));
  }
}
const identity = { serverId: 'server', sessionId: randomUUID(), draftId: randomUUID(), openedRevision: 2 };
const initial: Revision = { sessionId: identity.sessionId, draftId: identity.draftId, revision: 2, digest: 'base', summary: 'original', created: 1,
  canvas: { version: 0.4, last_node_id: 1, last_link_id: 0, nodes: [{ id: 1, type: 'Text', pos: [0, 0], size: [200, 100], widgets_values: ['original'] }], links: [], groups: [], config: {}, extra: {} }, bindings: [] };
const draft: Draft = { id: identity.draftId, sessionId: identity.sessionId, name: 'Image', headRevision: 6, outputKinds: ['image'], created: 1, updated: 6 };
const reader = { draft: async () => ({ draft }), revision: async (_session: string, _draft: string, revision: number) => ({ ...initial, revision }), asset: async (): Promise<AssetDetail> => { throw new Error('asset missing'); } };
const content = (text: string): DraftContent => { const canvas = structuredClone(initial.canvas); canvas.nodes[0].widgets_values = [text]; return { canvas, bindings: [] }; };
const ack = async (request: DraftSaveRequest) => ({ revision: { ...initial, canvas: request.canvas, bindings: request.bindings, sourceRevision: request.sourceRevision, revision: request.expectedHeadRevision + 1 } });
async function fixture() {
  const store = new MemoryCopies(); let request: DraftSaveRequest | undefined;
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { request = input; throw new Error('reply lost'); });
  await copy.checkpoint(content('submitted')); await assert.rejects(copy.flush('first save'));
  store.fail = true; await assert.rejects(copy.checkpoint(content('newest in memory')), /Disk full/); store.fail = false;
  const document = parseDraftRecovery(JSON.stringify(copy.recoverySnapshot()));
  return { store, copy, document, request: request! };
}

test('export/import keeps newest memory edits and the original unknown request in a separate paused copy', async () => {
  const f = await fixture(); const before = structuredClone(f.store.records);
  const imported = await importDraftRecovery(f.store, f.document, identity, reader);
  assert.notEqual(draftCopyKey(imported), draftCopyKey(identity));
  assert.deepEqual(f.store.records.get(draftCopyKey(identity)), before.get(draftCopyKey(identity)));
  const sent: DraftSaveRequest[] = [];
  const copy = await DraftWorkingCopy.open(f.store, imported, initial, 6, async input => { sent.push(input); return ack(input); });
  assert.equal(copy.content().canvas.nodes[0].widgets_values![0], 'newest in memory');
  assert.equal(copy.getSnapshot().recovering, true);
  await assert.rejects(copy.flush('automatic save'), /确认/); assert.equal(sent.length, 0);
  // Editing/reopening while reviewing does not release the sync hold.
  await copy.checkpoint(content('reviewed local edit'));
  const reopened = await DraftWorkingCopy.open(f.store, imported, initial, 6, async input => { sent.push(input); return ack(input); });
  await assert.rejects(reopened.flush('reopen'), /确认/);
  await reopened.confirmRecovery(); assert.equal(await reopened.flush('reviewed'), 7);
  assert.deepEqual(sent[0], f.request);
  assert.equal(sent[1].canvas.nodes[0].widgets_values![0], 'reviewed local edit');
  assert.equal(sent[1].sourceRevision, 6); assert.equal(sent[1].expectedHeadRevision, 6);
  assert.notEqual(sent[1].requestId, sent[0].requestId);
  assert.equal(reopened.getSnapshot().recovering, false);
});

test('recovery backup preserves an interrupted discard and does not replay canceled save or fork requests', async () => {
  const f = await fixture();
  await assert.rejects(f.copy.discardLocal(async () => { throw new Error('cancel acknowledgement lost'); }));
  const backup = parseDraftRecovery(JSON.stringify(f.copy.recoverySnapshot()));
  assert.ok(backup.record.discard);
  backup.record.discarded = { at: 1, savedRevision: 6, forkedTo: { draftId: randomUUID(), revision: 1 } };
  const imported = await importDraftRecovery(f.store, backup, identity, reader);
  const copy = await DraftWorkingCopy.open(f.store, imported, initial, 6, async () => { throw new Error('must never submit'); });
  assert.equal(copy.recoverySnapshot().record.discarded, undefined, 'a backup cannot assert a completed server result');
  await copy.confirmRecovery(); await assert.rejects(copy.flush('resume'), /放弃本机修改/);
  await assert.rejects(copy.resumeFork(async () => { throw new Error('must never fork'); }), /放弃本机修改/);
  const forkedTo = { draftId: randomUUID(), revision: 1 };
  await copy.discardLocal(async record => {
    assert.deepEqual(record.pending, f.request);
    return { revision: { ...initial, revision: 6 }, savedRevision: 6, forkedTo };
  });
  const saved = parseDraftRecovery(JSON.stringify(copy.recoverySnapshot()));
  assert.equal(saved.record.discard, undefined); assert.equal(saved.record.pending, undefined);
  assert.deepEqual(saved.record.discarded?.forkedTo, forkedTo);
});

test('import refuses foreign scope, forged bases and invalid identities before persisting', async () => {
  const f = await fixture(); const before = structuredClone(f.store.records);
  await assert.rejects(importDraftRecovery(f.store, f.document, { ...identity, serverId: 'foreign' }, reader), /服务器和对话/);
  await assert.rejects(importDraftRecovery(f.store, f.document, { ...identity, sessionId: randomUUID() }, reader), /服务器和对话/);
  const forged = structuredClone(f.document); forged.record.base = content('invented base');
  await assert.rejects(importDraftRecovery(f.store, forged, identity, reader), /基础版本/);
  const mismatched = structuredClone(f.document); mismatched.record.pending!.expectedHeadRevision++;
  assert.throws(() => parseDraftRecovery(JSON.stringify(mismatched)), /版本或请求/);
  const changedFork = structuredClone(f.document);
  changedFork.record.fork = { request: { ...content('different fork content'), requestId: randomUUID(), sourceRevision: 2, name: 'Old fork request' } };
  assert.throws(() => parseDraftRecovery(JSON.stringify(changedFork)), /版本或请求/, 'never open a fork result in place of newer local content');
  const unknownFormat = { ...f.document, schemaVersion: 9 };
  assert.throws(() => parseDraftRecovery(JSON.stringify(unknownFormat)), /格式/);
  assert.throws(() => parseDraftRecovery('{'), /JSON/);
  assert.throws(() => parseDraftRecovery(' '.repeat(8 * 1024 * 1024 + 1)), /8 MB/);
  assert.deepEqual(f.store.records, before);
});

test('import checks referenced asset ownership without requiring generated bytes to be ready', async () => {
  const f = await fixture(); const id = randomUUID();
  f.document.local.bindings = [{ id: 'binding', nodeId: '1', inputName: 'image', role: 'reference_image', assetId: id }];
  const asset: AssetDetail = { asset: { id, sessionId: identity.sessionId, kind: 'image', name: 'Image', origin: 'uploaded', displayOrdinal: 1, captureState: 'missing', metadata: {}, created: 1 }, sourceRun: null };
  await assert.rejects(inspectDraftRecovery(f.document, identity, reader), /missing/);
  const wrong = { ...reader, asset: async () => ({ ...asset, asset: { ...asset.asset, sessionId: randomUUID() } }) };
  await assert.rejects(inspectDraftRecovery(f.document, identity, wrong), /其他对话/);
  assert.equal((await inspectDraftRecovery(f.document, identity, { ...reader, asset: async () => asset })).id, identity.draftId);
});

test('disk failure leaves existing copies intact and repeated imports use different local keys with the same outbox', async () => {
  const f = await fixture(); const before = structuredClone(f.store.records);
  f.store.fail = true; await assert.rejects(importDraftRecovery(f.store, f.document, identity, reader), /Disk full/);
  assert.deepEqual(f.store.records, before); f.store.fail = false;
  const first = await importDraftRecovery(f.store, f.document, identity, reader);
  const second = await importDraftRecovery(f.store, f.document, identity, reader);
  assert.notEqual(first.copyId, second.copyId);
  assert.deepEqual(f.store.records.get(draftCopyKey(first))!.pending, f.store.records.get(draftCopyKey(second))!.pending);
  await assert.rejects(DraftWorkingCopy.open(f.store, { ...identity, copyId: randomUUID() }, initial, 6, ack), /副本不存在/);
  assert.equal(f.store.records.size, 3);
});

test('a backup cannot declare its pending request rejected or its fork already acknowledged', async () => {
  const f = await fixture();
  f.document.record.rejected = { requestId: f.request.requestId, status: 422, message: 'untrusted rejection' };
  const imported = await importDraftRecovery(f.store, f.document, identity, reader);
  const copy = await DraftWorkingCopy.open(f.store, imported, initial, 6, ack);
  assert.equal(copy.getSnapshot().rejected, false);
  await assert.rejects(copy.repairRejected('skip original'), /核对/);
  const forkId = randomUUID(); const forkRequest = { ...f.document.local, requestId: randomUUID(), sourceRevision: 2, name: 'Recovered fork' };
  f.document.record.fork = { request: forkRequest, result: { draftId: randomUUID(), revision: 1 } };
  const forkIdentity = await importDraftRecovery(f.store, f.document, identity, reader);
  const fork = await DraftWorkingCopy.open(f.store, forkIdentity, initial, 6, ack);
  assert.equal(fork.getSnapshot().forkedTo, undefined); assert.equal(fork.getSnapshot().forking, true);
  let writes = 0;
  const send = async (input: typeof forkRequest) => {
    writes++; assert.deepEqual(input, forkRequest);
    return { draft: { ...draft, id: forkId, headRevision: 1, forkedFrom: { draftId: identity.draftId, revision: 2 } }, revision: { ...initial, draftId: forkId, revision: 1, canvas: input.canvas, bindings: input.bindings } };
  };
  await assert.rejects(fork.resumeFork(send), /确认/); assert.equal(writes, 0);
  await fork.confirmRecovery(); assert.deepEqual(await fork.resumeFork(send), { draftId: forkId, revision: 1 });
  assert.equal(writes, 1);
});

test('a recovery file produced after an earlier import remains parseable with the same immutable request', async () => {
  const f = await fixture(); const imported = await importDraftRecovery(f.store, f.document, identity, reader);
  const copy = await DraftWorkingCopy.open(f.store, imported, initial, 6, ack);
  const second: DraftRecoveryDocument = parseDraftRecovery(JSON.stringify(copy.recoverySnapshot()));
  assert.deepEqual(second.record.pending, f.request);
  assert.equal(second.record.recovery?.reviewRequired, true);
  const restored = await importDraftRecovery(new MemoryCopies(), second, identity, reader);
  assert.notEqual(restored.copyId, imported.copyId);
});
