import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftWorkingCopy, draftCopyKey } from '../../src/infrastructure/storage/DraftWorkingCopy';
import type { DraftCopyRecord } from '../../src/infrastructure/storage/DraftWorkingCopy';
import { canvasEnvironmentKey } from '../../src/infrastructure/storage/DraftCanvasCache';
import type { DraftCanvasContext, DraftCanvasEnvironment } from '../../src/infrastructure/storage/DraftCanvasCache';
import { loadDraftCanvas } from '../../src/infrastructure/storage/DraftCanvasLoader';
import type { Draft, Revision } from '../../src/shared/types/agentWorkspace';

class Cache {
  contexts = new Map<string, { context: DraftCanvasContext; environment: DraftCanvasEnvironment }>(); records = new Map<string, DraftCopyRecord>(); failCache = false;
  async read(key: string) { return structuredClone(this.records.get(key)); }
  async compareAndSwap(key: string, epoch: number | undefined, next: DraftCopyRecord) { assert.equal(this.records.get(key)?.epoch, epoch); this.records.set(key, structuredClone(next)); }
  async readCanvasContext(key: string) { return structuredClone(this.contexts.get(key)); }
  async saveCanvasContext(context: DraftCanvasContext, environment: DraftCanvasEnvironment) { if (this.failCache) throw new Error('Cache full'); this.contexts.set(context.key, structuredClone({ context, environment })); }
}
const baseUrl = 'http://gateway.test'; const reference = { sessionId: 'session', draftId: 'image', openedRevision: 2 };
const identity = { ...reference, serverId: 'server' };
const revision: Revision = { sessionId: 'session', draftId: 'image', revision: 2, digest: 'digest', summary: 'original', created: 1,
  canvas: { version: 0.4, last_node_id: 0, last_link_id: 0, nodes: [], links: [], groups: [], config: {}, extra: {} }, bindings: [] };
const draft: Draft = { id: 'image', sessionId: 'session', name: 'Image', headRevision: 5, outputKinds: ['image'], created: 1, updated: 5 };
const reader = {
  status: async () => ({ enabled: true, providerReady: false, model: null, agentSchemaVersion: 2, serverId: 'server' }),
  api: (serverId: string) => { assert.equal(serverId, 'server'); return { draft: async () => ({ draft }), revision: async () => revision }; },
  objectInfo: async () => ({}),
};
const signal = () => new AbortController().signal;
async function seed(store = new Cache()) {
  const loaded = await loadDraftCanvas(store, baseUrl, reference, reader, signal());
  const copy = await DraftWorkingCopy.open(store, identity, loaded.revision, loaded.draft.headRevision, async () => { throw new Error('reply lost'); });
  await copy.checkpoint({ canvas: { ...revision.canvas, extra: { local: 'newer' } }, bindings: [] });
  await assert.rejects(copy.flush('edit'), /reply lost/);
  return { store, copy, loaded };
}
test('offline reopening uses cached node definitions and preserves the original local outbox', async () => {
  const { store, copy } = await seed(); const before = copy.recoverySnapshot().record;
  const offline = await loadDraftCanvas(store, baseUrl, reference, { ...reader, status: async () => { throw new Error('offline'); } }, signal());
  assert.equal(offline.online, false); assert.deepEqual(offline.objectInfo, {});
  const reopened = await DraftWorkingCopy.open(store, identity, offline.revision, offline.draft.headRevision, async () => { throw new Error('must reconnect'); });
  assert.deepEqual(reopened.recoverySnapshot().record, before);
  assert.deepEqual(reopened.content().canvas.extra, { local: 'newer' });
});
test('a different server at the same URL cannot replace the cached environment or send scoped reads', async () => {
  const { store } = await seed(); const before = structuredClone(store.contexts);
  const loaded = await loadDraftCanvas(store, baseUrl, reference, { ...reader, status: async () => ({ ...await reader.status(), serverId: 'another-server' }), api: () => { throw new Error('must not read the replacement server'); } }, signal());
  assert.equal(loaded.online, false); assert.equal(loaded.serverId, 'server'); assert.match(loaded.warning!, /身份/);
  assert.deepEqual(store.contexts, before);
  assert.notEqual(canvasEnvironmentKey(baseUrl, 'server'), canvasEnvironmentKey(baseUrl, 'another-server'));
});
test('fresh server metadata never rebases the local pending request to a newer head', async () => {
  const { store, copy } = await seed();
  const loaded = await loadDraftCanvas(store, baseUrl, reference, { ...reader, api: () => ({ draft: async () => ({ draft: { ...draft, headRevision: 12 } }), revision: async () => revision }) }, signal());
  assert.equal(loaded.online, true); assert.equal(loaded.draft.headRevision, 12);
  const reopened = await DraftWorkingCopy.open(store, identity, loaded.revision, loaded.draft.headRevision, async () => { throw new Error('409'); });
  assert.deepEqual(reopened.recoverySnapshot().record.pending, copy.recoverySnapshot().record.pending);
  assert.equal(reopened.getSnapshot().expectedHeadRevision, 5);
});
test('cache failures report limited offline availability while cold or missing copies cannot open offline', async () => {
  const store = new Cache(); store.failCache = true;
  const loaded = await loadDraftCanvas(store, baseUrl, reference, reader, signal());
  assert.equal(loaded.online, true); assert.match(loaded.warning!, /未能保存/);
  const offline = { ...reader, status: async () => { throw new Error('offline'); } };
  await assert.rejects(loadDraftCanvas(store, baseUrl, reference, offline, signal()), /offline/);
  store.failCache = false; await seed(store); store.records.clear();
  await assert.rejects(loadDraftCanvas(store, baseUrl, reference, offline, signal()), /没有可离线/);
  await assert.rejects(loadDraftCanvas(store, 'http://other.test', reference, offline, signal()), /offline/);
  assert.equal(store.records.size, 0);
});
test('leaving during an online read aborts without loading an old cached document', async () => {
  const { store } = await seed(); const controller = new AbortController(); controller.abort();
  await assert.rejects(loadDraftCanvas(store, baseUrl, reference, { ...reader, status: async () => { throw new Error('cancelled'); } }, controller.signal), { name: 'AbortError' });
});
test('an isolated recovery copy can reopen offline without falling back to the default editor slot', async () => {
  const { store, copy } = await seed(); const isolated = await copy.isolateForFork('Separate');
  const offline = { ...reader, status: async () => { throw new Error('offline'); } };
  assert.equal((await loadDraftCanvas(store, baseUrl, isolated, offline, signal())).online, false);
  store.records.delete(draftCopyKey(isolated));
  await assert.rejects(loadDraftCanvas(store, baseUrl, isolated, offline, signal()), /没有可离线/);
  assert.ok(store.records.has(draftCopyKey(identity)));
});
