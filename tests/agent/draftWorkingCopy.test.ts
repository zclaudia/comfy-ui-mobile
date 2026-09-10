import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftCopyConflict, DraftWorkingCopy, draftCopyKey } from '../../src/infrastructure/storage/DraftWorkingCopy';
import type { DraftContent, DraftCopyRecord, DraftCopyStore, DraftSaveRequest } from '../../src/infrastructure/storage/DraftWorkingCopy';
import type { Revision } from '../../src/shared/types/agentWorkspace';
import { bindDraftAsset, bindingsForCanvas, DraftWorkflowStorage } from '../../src/infrastructure/storage/DraftWorkflowStorage';
import type { Asset, Draft } from '../../src/shared/types/agentWorkspace';

class MemoryCopies implements DraftCopyStore {
  records = new Map<string, DraftCopyRecord>();
  fail = false;
  async read(key: string) { return structuredClone(this.records.get(key)); }
  async compareAndSwap(key: string, epoch: number | undefined, next: DraftCopyRecord) {
    if (this.fail) throw new Error('Disk full');
    if (this.records.get(key)?.epoch !== epoch) throw new DraftCopyConflict();
    this.records.set(key, structuredClone(next));
  }
}
const identity = { serverId: 'server', sessionId: 'session', draftId: 'image', openedRevision: 2 };
const initial: Revision = { sessionId: 'session', draftId: 'image', revision: 2, digest: 'digest', summary: 'original', created: 0,
  canvas: { version: 0.4, last_node_id: 1, last_link_id: 0, nodes: [{ id: 1, type: 'Text', pos: [0, 0], size: [200, 100], widgets_values: ['original'] }], links: [], groups: [], config: {}, extra: {} }, bindings: [] };
function content(value: string): DraftContent {
  const canvas = structuredClone(initial.canvas); canvas.nodes[0].widgets_values = [value];
  return { canvas, bindings: [] };
}
const ack = async (request: DraftSaveRequest) => ({ revision: { ...initial, canvas: request.canvas, bindings: request.bindings,
  revision: request.expectedHeadRevision + 1, sourceRevision: request.sourceRevision } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test('discard keeps an unknown outbox through reload and adopts only a verified server snapshot', async () => {
  const store = new MemoryCopies(); let sends = 0;
  const send = async () => { sends++; throw new Error('reply lost'); };
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, send);
  await copy.checkpoint(content('sent')); await assert.rejects(copy.flush('save'));
  await copy.checkpoint(content('newest unsent'));
  const pending = copy.recoverySnapshot().record.pending;
  await assert.rejects(copy.discardLocal(async record => {
    assert.deepEqual(record.pending, pending); assert.equal(record.local.canvas.nodes[0].widgets_values![0], 'newest unsent');
    throw new Error('cancel reply lost');
  }), /cancel reply lost/);
  const reopened = await DraftWorkingCopy.open(store, identity, initial, 6, send);
  assert.equal(reopened.getSnapshot().discarding, true);
  await assert.rejects(reopened.flush('must not replay'));
  await assert.rejects(reopened.checkpoint(content('late old editor')));
  await assert.rejects(reopened.isolateForFork('no fork during discard'));
  await assert.rejects(reopened.discardLocal(async () => ({ revision: { ...initial, draftId: 'other', revision: 6 } })), /核对结果不一致/);
  assert.deepEqual(reopened.recoverySnapshot().record.pending, pending);
  const remote = { ...initial, ...content('server latest'), revision: 6 };
  await reopened.discardLocal(async record => { assert.deepEqual(record.pending, pending); return { revision: remote, savedRevision: 6 }; });
  await assert.rejects(reopened.checkpoint(content('late autosave')));
  const clean = await DraftWorkingCopy.open(store, identity, initial, 6, send);
  assert.equal(clean.getSnapshot().discarding, false); assert.equal(clean.getSnapshot().dirty, false);
  assert.equal(clean.getSnapshot().pending, false); assert.equal(clean.getSnapshot().sourceRevision, 6);
  assert.equal(clean.content().canvas.nodes[0].widgets_values![0], 'server latest');
  assert.equal(clean.recoverySnapshot().record.discarded?.savedRevision, 6);
  assert.equal(await clean.flush('no empty version'), 6); assert.equal(sends, 1);
});

test('discard commits locally before network, tolerates lost disk acknowledgement, and respects other editors', async () => {
  const store = new MemoryCopies(); const copy = await DraftWorkingCopy.open(store, identity, initial, 5, ack);
  await copy.checkpoint(content('local')); let resolutions = 0;
  const resolve = async () => { resolutions++; return { revision: { ...initial, revision: 5 } }; };
  store.fail = true; await assert.rejects(copy.discardLocal(resolve), /Disk full/);
  assert.equal(resolutions, 0); assert.equal(copy.content().canvas.nodes[0].widgets_values![0], 'local');
  store.fail = false;
  await assert.rejects(copy.discardLocal(async () => { resolutions++; store.fail = true; return { revision: { ...initial, revision: 5 } }; }), /Disk full/);
  assert.equal(copy.getSnapshot().discarding, true); assert.equal(copy.content().canvas.nodes[0].widgets_values![0], 'local');
  store.fail = false; await copy.discardLocal(resolve);
  const one = await DraftWorkingCopy.open(store, identity, initial, 5, ack);
  const two = await DraftWorkingCopy.open(store, identity, initial, 5, ack);
  await two.checkpoint(content('another window'));
  const before = resolutions; await assert.rejects(one.discardLocal(resolve), DraftCopyConflict);
  assert.equal(resolutions, before);
  assert.equal((await store.read(draftCopyKey(identity)))!.local.canvas.nodes[0].widgets_values![0], 'another window');
});

test('discard never races an active save and concurrent discard clicks share one cancellation', async () => {
  const store = new MemoryCopies(); const entered = deferred<void>(); const release = deferred<void>();
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { entered.resolve(); await release.promise; return ack(input); });
  await copy.checkpoint(content('sending')); const flight = copy.flush('save'); await entered.promise;
  await assert.rejects(copy.discardLocal(async () => { throw new Error('must not cancel during save'); }), /等待当前保存/);
  release.resolve(); await flight;
  const gate = deferred<void>(); let calls = 0;
  const cancel = copy.discardLocal(async () => { calls++; await gate.promise; return { revision: { ...initial, revision: 6 } }; });
  assert.equal(copy.discardLocal(async () => { throw new Error('duplicate'); }), cancel);
  await assert.rejects(copy.flush('blocked'));
  gate.resolve(); await cancel; assert.equal(calls, 1);
});

test('historical editing keeps source revision separate from the current head, without empty revisions', async () => {
  const store = new MemoryCopies(); const sent: DraftSaveRequest[] = [];
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { sent.push(input); return ack(input); });
  assert.equal(await copy.flush('unchanged'), 2); assert.equal(sent.length, 0);
  await copy.checkpoint(content('beach'));
  assert.equal(await copy.flush('background'), 6);
  assert.equal(sent[0].sourceRevision, 2); assert.equal(sent[0].expectedHeadRevision, 5);
  assert.equal(await copy.flush('unchanged'), 6); assert.equal(sent.length, 1);
  assert.equal(copy.getSnapshot().dirty, false);
});

test('reload after lost acknowledgement replays the exact immutable payload before submitting newer edits', async () => {
  const store = new MemoryCopies(); const sent: DraftSaveRequest[] = [];
  const first = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { sent.push(input); throw new Error('reply lost'); });
  await first.checkpoint(content('first'));
  await assert.rejects(first.flush('first change'), /reply lost/);
  await first.checkpoint(content('second'));
  const reopened = await DraftWorkingCopy.open(store, identity, initial, 6, async input => { sent.push(input); return ack(input); });
  assert.equal(reopened.content().canvas.nodes[0].widgets_values![0], 'second');
  assert.equal(await reopened.flush('newer change'), 7);
  assert.deepEqual(sent[1], sent[0]);
  assert.notEqual(sent[2].requestId, sent[0].requestId);
  assert.equal(sent[2].expectedHeadRevision, 6); assert.equal(sent[2].sourceRevision, 6);
  assert.equal(sent[2].canvas.nodes[0].widgets_values![0], 'second');
});

test('editing and checkpointing continue while a network save is pending; concurrent flushes share one flight', async () => {
  const store = new MemoryCopies(); const entered = deferred<void>(); const release = deferred<void>(); const sent: DraftSaveRequest[] = [];
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => {
    sent.push(input); if (sent.length === 1) { entered.resolve(); await release.promise; } return ack(input);
  });
  await copy.checkpoint(content('first'));
  const flush = copy.flush('save'); await entered.promise;
  assert.equal(copy.flush('duplicate button'), flush);
  await copy.checkpoint(content('new edit during save'));
  const disk = await store.read(draftCopyKey(identity));
  assert.equal(disk!.local.canvas.nodes[0].widgets_values![0], 'new edit during save');
  assert.equal(disk!.pending!.canvas.nodes[0].widgets_values![0], 'first');
  release.resolve(); assert.equal(await flush, 7);
  assert.equal(sent.length, 2); assert.equal(copy.getSnapshot().dirty, false);
});

test('server conflicts retain original CAS and local changes across reopening; no automatic head adoption', async () => {
  const store = new MemoryCopies(); const sent: DraftSaveRequest[] = [];
  const reject = async (input: DraftSaveRequest): Promise<{ revision: Revision }> => { sent.push(input); throw new Error('409 head changed'); };
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, reject);
  await copy.checkpoint(content('keep me')); await assert.rejects(copy.flush('edit'));
  const reopened = await DraftWorkingCopy.open(store, identity, initial, 12, reject);
  await assert.rejects(reopened.flush('retry'));
  assert.deepEqual(sent[1], sent[0]); assert.equal(reopened.getSnapshot().expectedHeadRevision, 5);
  assert.equal(reopened.content().canvas.nodes[0].widgets_values![0], 'keep me');
});

test('two editors cannot overwrite the same local working copy or submit a stale local document', async () => {
  const store = new MemoryCopies(); let sends = 0;
  const send = async (input: DraftSaveRequest) => { sends++; return ack(input); };
  const first = await DraftWorkingCopy.open(store, identity, initial, 5, send);
  const second = await DraftWorkingCopy.open(store, identity, initial, 5, send);
  await first.checkpoint(content('first writer'));
  await assert.rejects(second.checkpoint(content('stale writer')), DraftCopyConflict);
  assert.equal((await store.read(draftCopyKey(identity)))!.local.canvas.nodes[0].widgets_values![0], 'first writer');
  assert.equal(sends, 0);
});

test('local storage failures prevent submission and do not report edits as saved', async () => {
  const store = new MemoryCopies(); let sends = 0;
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { sends++; return ack(input); });
  store.fail = true; await assert.rejects(copy.checkpoint(content('unsaved')), /Disk full/);
  assert.ok(copy.getSnapshot().error); assert.equal(sends, 0);
  store.fail = false; await copy.checkpoint(content('unsaved')); store.fail = true;
  await assert.rejects(copy.flush('change'), /Disk full/);
  assert.equal(sends, 0); assert.equal(copy.getSnapshot().dirty, true);
});

test('server, session, draft and historical base each isolate the durable buffer', async () => {
  assert.equal(new Set([
    identity, { ...identity, serverId: 'other' }, { ...identity, sessionId: 'other' },
    { ...identity, draftId: 'other' }, { ...identity, openedRevision: 1 },
  ].map(draftCopyKey)).size, 5);
  await assert.rejects(DraftWorkingCopy.open(new MemoryCopies(), { ...identity, draftId: 'video' }, initial, 5, ack), /identity/);
});

test('a foreign or altered acknowledgement cannot clear the durable outbox', async () => {
  const store = new MemoryCopies();
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => ({ revision: { ...(await ack(input)).revision, draftId: 'video' } }));
  await copy.checkpoint(content('change')); await assert.rejects(copy.flush('edit'), /acknowledgement/);
  assert.equal(copy.getSnapshot().pending, true); assert.equal(copy.getSnapshot().dirty, true);
  assert.equal(copy.getSnapshot().sourceRevision, 2);
});

test('draft editor storage saves canvas data to the exact draft version without library metadata or runtime graph objects', async () => {
  const store = new MemoryCopies(); const sent: DraftSaveRequest[] = [];
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { sent.push(input); return ack(input); });
  const draft: Draft = { id: 'image', sessionId: 'session', name: 'Image', headRevision: 5, outputKinds: ['image'], created: 1, updated: 5 };
  const storage = new DraftWorkflowStorage(copy, draft, identity, () => 'Canvas edit');
  const workflow = await storage.load();
  assert.ok(workflow.id.startsWith('agent-draft:')); assert.equal(workflow.cloud, undefined); assert.equal(workflow.agent, undefined);
  workflow.workflow_json = content('canvas edit').canvas;
  workflow.parsedData = { runtimeFunction: () => undefined };
  await storage.save(workflow);
  assert.equal(sent.length, 1); assert.equal(sent[0].expectedHeadRevision, 5); assert.equal(sent[0].sourceRevision, 2);
  assert.equal('parsedData' in sent[0], false);
  await assert.rejects(storage.save({ ...workflow, id: 'formal-library-file' }), /different document/);
  assert.equal(sent.length, 1);
});

test('changing a draft reference changes its binding and canvas token atomically while preserving other settings', () => {
  const canvas = content('old-file.png').canvas; canvas.nodes[0].type = 'LoadImage'; canvas.nodes[0].widgets_values!.push('extra widget');
  const asset: Asset = { id: 'new-image', sessionId: 'session', kind: 'image', name: 'Image', origin: 'uploaded', displayOrdinal: 1, captureState: 'ready', metadata: {}, created: 1 };
  const next = bindDraftAsset({ canvas, bindings: [] }, '1', asset, 'session');
  assert.deepEqual(canvas.nodes[0].widgets_values, ['old-file.png', 'extra widget']);
  assert.deepEqual(next.canvas.nodes[0].widgets_values, ['asset:new-image', 'extra widget']);
  assert.equal(next.bindings[0].assetId, asset.id); assert.equal(next.bindings[0].role, 'reference_image');
  const replaced = bindDraftAsset(next, '1', { ...asset, id: 'another-image' }, 'session');
  assert.equal(replaced.bindings[0].id, next.bindings[0].id); assert.equal(replaced.bindings.length, 1);
  assert.equal(next.bindings[0].assetId, 'new-image');
  const multi = structuredClone(next);
  multi.bindings.push({ id: 'other-input', nodeId: '2', inputName: 'image', role: 'reference_image', assetId: 'other-asset' });
  assert.deepEqual(bindDraftAsset(multi, '1', asset, 'session'), multi, 'selecting the same reference does not reorder bindings or create an empty revision');
  assert.throws(() => bindDraftAsset(next, '1', { ...asset, sessionId: 'foreign' }, 'session'), /another session/);
  assert.throws(() => bindDraftAsset(next, '1', { ...asset, kind: 'video' }, 'session'), /Incompatible/);
  assert.deepEqual(bindingsForCanvas(next.canvas, next.bindings), next.bindings);
  const rawEdit = structuredClone(next.canvas); rawEdit.nodes[0].widgets_values![0] = 'arbitrary.png';
  assert.throws(() => bindingsForCanvas(rawEdit, next.bindings), /asset picker/);
  rawEdit.nodes = [];
  assert.deepEqual(bindingsForCanvas(rawEdit, next.bindings), []);
});

test('runtime logging proxies are normalized at the draft JSON boundary', async () => {
  const store = new MemoryCopies(); const copy = await DraftWorkingCopy.open(store, identity, initial, 5, ack);
  const local = content('proxy text');
  local.canvas.nodes[0].properties = new Proxy({ name: 'runtime observable' }, {});
  assert.throws(() => structuredClone(local));
  await copy.checkpoint(local);
  assert.doesNotThrow(() => structuredClone(copy.content()));
  assert.equal(await copy.flush('save proxy'), 6);
  assert.equal(copy.content().canvas.nodes[0].properties.name, 'runtime observable');
});

test('disk failure retains the newest volatile canvas for export and a later successful checkpoint', async () => {
  const store = new MemoryCopies(); const copy = await DraftWorkingCopy.open(store, identity, initial, 5, ack);
  store.fail = true; await assert.rejects(copy.checkpoint(content('unsaved newest')));
  assert.equal(copy.getSnapshot().memoryOnly, true);
  assert.equal(copy.content().canvas.nodes[0].widgets_values![0], 'unsaved newest');
  const backup = copy.recoverySnapshot();
  assert.equal(backup.local.canvas.nodes[0].widgets_values![0], 'unsaved newest');
  assert.equal(backup.record.local.canvas.nodes[0].widgets_values![0], 'original');
  store.fail = false;
  assert.equal(await copy.flush('retry after disk recovery'), 6);
  assert.equal(copy.getSnapshot().memoryOnly, false); assert.equal(copy.getSnapshot().dirty, false);
});

test('a definite validation rejection can be repaired with a new request while unknown outcomes cannot', async () => {
  const store = new MemoryCopies(); const sent: DraftSaveRequest[] = [];
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async request => {
    sent.push(request); if (sent.length === 1) throw Object.assign(new Error('invalid canvas'), { status: 422 }); return ack(request);
  });
  await copy.checkpoint(content('bad canvas')); await assert.rejects(copy.flush('bad'));
  assert.equal(copy.getSnapshot().rejected, true);
  await assert.rejects(copy.repairRejected('unchanged'), /修正/);
  await copy.checkpoint(content('repaired canvas'));
  const reopened = await DraftWorkingCopy.open(store, identity, initial, 5, async request => { sent.push(request); return ack(request); });
  assert.equal(reopened.getSnapshot().rejected, true);
  assert.equal(await reopened.repairRejected('repair'), 6);
  assert.notEqual(sent[1].requestId, sent[0].requestId);
  assert.equal(sent[1].sourceRevision, 2); assert.equal(sent[1].expectedHeadRevision, 5);
  assert.deepEqual(reopened.recoverySnapshot().record.rejectedRequests![0].request, sent[0]);
  const unknown = await DraftWorkingCopy.open(new MemoryCopies(), identity, initial, 5, async () => { throw new Error('timeout'); });
  await unknown.checkpoint(content('first')); await assert.rejects(unknown.flush('unknown'));
  await unknown.checkpoint(content('later')); await assert.rejects(unknown.repairRejected('unsafe'), /核对/);
});

test('local CAS conflicts fork this editor content under a separate durable identity without overwriting another editor', async () => {
  const store = new MemoryCopies(); let originalSends = 0;
  const send = async (input: DraftSaveRequest) => { originalSends++; return ack(input); };
  const a = await DraftWorkingCopy.open(store, identity, initial, 5, send);
  const b = await DraftWorkingCopy.open(store, identity, initial, 5, send);
  await a.checkpoint(content('other editor'));
  await assert.rejects(b.checkpoint(content('my isolated direction')), DraftCopyConflict);
  const isolated = await b.isolateForFork('My direction');
  assert.ok(isolated.copyId); assert.notEqual(draftCopyKey(isolated), draftCopyKey(identity));
  const reopened = await DraftWorkingCopy.open(store, isolated, initial, 5, send);
  assert.equal(reopened.content().canvas.nodes[0].widgets_values![0], 'my isolated direction');
  assert.equal((await store.read(draftCopyKey(identity)))!.local.canvas.nodes[0].widgets_values![0], 'other editor');
  await assert.rejects(reopened.flush('must not edit source'), /另存/);
  const requests: unknown[] = [];
  const forkAck = (input: { canvas: Revision['canvas']; bindings: Revision['bindings']; sourceRevision: number; name: string }) => ({
    draft: { id: 'forked', sessionId: 'session', name: input.name, headRevision: 1, outputKinds: ['image' as const], created: 1, updated: 1, forkedFrom: { draftId: 'image', revision: input.sourceRevision } },
    revision: { ...initial, draftId: 'forked', revision: 1, canvas: input.canvas, bindings: input.bindings },
  });
  await assert.rejects(reopened.resumeFork(async input => { requests.push(input); throw new Error('response lost'); }));
  const again = await DraftWorkingCopy.open(store, isolated, initial, 9, send);
  const result = await again.resumeFork(async input => { requests.push(input); return forkAck(input); });
  assert.deepEqual(requests[1], requests[0]); assert.deepEqual(result, { draftId: 'forked', revision: 1 });
  assert.equal(originalSends, 0);
  assert.deepEqual(await again.resumeFork(async () => { throw new Error('must not resubmit'); }), result);
});

test('a newer in-memory checkpoint is not cleared while an older disk retry is committing', async () => {
  const store = new MemoryCopies(); const sent: DraftSaveRequest[] = [];
  const copy = await DraftWorkingCopy.open(store, identity, initial, 5, async input => { sent.push(input); return ack(input); });
  store.fail = true; await assert.rejects(copy.checkpoint(content('first retained edit')));
  store.fail = false; const entered = deferred<void>(); const release = deferred<void>(); const original = store.compareAndSwap.bind(store); let block = true;
  store.compareAndSwap = async (key, epoch, next) => { if (block) { block = false; entered.resolve(); await release.promise; } await original(key, epoch, next); };
  const retry = copy.flush('retry disk write'); await entered.promise;
  const newer = copy.checkpoint(content('newer edit while disk write awaits'));
  assert.equal(copy.content().canvas.nodes[0].widgets_values![0], 'newer edit while disk write awaits');
  release.resolve(); await newer; await retry;
  assert.equal(copy.getSnapshot().memoryOnly, false); assert.equal(copy.getSnapshot().dirty, false);
  assert.equal(sent.at(-1)!.canvas.nodes[0].widgets_values![0], 'newer edit while disk write awaits');
  assert.equal((await store.read(draftCopyKey(identity)))!.local.canvas.nodes[0].widgets_values![0], 'newer edit while disk write awaits');
});
