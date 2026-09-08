import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyHashCanvas, planLegacyMigration } from '../../src/components/agent/migration';
import type { AgentSession } from '../../src/infrastructure/api/AgentApi';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';

const canvas = { nodes: [{ id: 1, type: 'KSampler' }], links: [] };
const wf = (id: string, extra: Partial<Workflow> = {}): Workflow => ({ id, name: id, workflow_json: canvas as never, nodeCount: 1, createdAt: new Date(0), isValid: true, ...extra });
const legacy = (extra: Partial<AgentSession> = {}): AgentSession => ({ id: 's1', name: '海报', version: 3, created: 0, workspaceMode: 'legacy', legacyWorkflow: { id: 'a', name: '海报', filename: '海报.json' }, ...extra });
const sha = 'f'.repeat(64);

test('a matching library copy becomes both the source and the last library save', () => {
  const bound = wf('a', { cloud: { provider: 'comfyui', filename: '海报.json', etag: 'e1' }, agent: { sessionId: 's1', mirroredVersion: 3, mirroredHash: legacyHashCanvas(canvas) } });
  const plan = planLegacyMigration({ session: legacy(), workflows: [bound], latestCanvas: canvas, latestGraphHash: sha, serverId: 'http://c', now: 7 });
  assert.deepEqual(plan.patch, {
    workspaceMode: 'draft',
    sourceRef: { serverId: 'http://c', workflowId: 'a', filename: '海报.json', name: 'a', etag: 'e1' },
    lastLibrarySave: { serverId: 'http://c', workflowId: 'a', filename: '海报.json', name: 'a', draftVersion: 3, graphHash: sha, etag: 'e1', opId: 'legacy', at: 7 },
  });
  assert.equal(plan.clearBinding, 'a');
});

test('an edited library copy keeps only the source, so the user decides which side to continue from', () => {
  const edited = wf('a', { workflow_json: { nodes: [{ id: 1 }, { id: 2 }], links: [] } as never, cloud: { provider: 'comfyui', filename: '海报.json' }, agent: { sessionId: 's1', mirroredVersion: 2, mirroredHash: legacyHashCanvas(canvas) } });
  const plan = planLegacyMigration({ session: legacy(), workflows: [edited], latestCanvas: { nodes: [{ id: 1 }, { id: 2 }, { id: 3 }], links: [] }, latestGraphHash: sha, serverId: 'http://c' });
  assert.equal(plan.patch.lastLibrarySave, undefined);
  assert.equal(plan.patch.sourceRef?.workflowId, 'a');
  assert.equal(plan.clearBinding, 'a');
});

test('the binding resolves through the cloud filename when the id differs on this device', () => {
  const redownloaded = wf('cloud_x', { cloud: { provider: 'comfyui', filename: '海报.json' }, agent: { sessionId: 's1', mirroredVersion: 3, mirroredHash: legacyHashCanvas(canvas) } });
  const plan = planLegacyMigration({ session: legacy(), workflows: [redownloaded], latestCanvas: canvas, latestGraphHash: sha, serverId: 'http://c' });
  assert.equal(plan.patch.sourceRef?.workflowId, 'cloud_x');
  assert.equal(plan.patch.lastLibrarySave?.draftVersion, 3);
});

test('a missing, local-only or foreign-bound copy only flips the mode and never invents a library entry', () => {
  const none = planLegacyMigration({ session: legacy(), workflows: [], latestCanvas: canvas, latestGraphHash: sha, serverId: 'http://c' });
  assert.deepEqual(none, { patch: { workspaceMode: 'draft' } });
  const localOnly = wf('a', { agent: { sessionId: 's1', mirroredVersion: 3, mirroredHash: legacyHashCanvas(canvas) } });
  assert.deepEqual(planLegacyMigration({ session: legacy(), workflows: [localOnly], latestCanvas: canvas, latestGraphHash: sha, serverId: 'http://c' }), { patch: { workspaceMode: 'draft' } });
  const foreign = wf('a', { cloud: { provider: 'comfyui', filename: '海报.json' }, agent: { sessionId: 'other', mirroredVersion: 3, mirroredHash: legacyHashCanvas(canvas) } });
  assert.deepEqual(planLegacyMigration({ session: legacy(), workflows: [foreign], latestCanvas: canvas, latestGraphHash: sha, serverId: 'http://c' }), { patch: { workspaceMode: 'draft' } });
  const unbound = planLegacyMigration({ session: legacy({ legacyWorkflow: undefined }), workflows: [foreign], latestCanvas: canvas, latestGraphHash: sha, serverId: 'http://c' });
  assert.deepEqual(unbound, { patch: { workspaceMode: 'draft' } });
});

test('legacyHashCanvas reproduces the pre-draft hash format', () => {
  assert.match(legacyHashCanvas(canvas), /^[0-9a-f]{16}$/);
  assert.equal(legacyHashCanvas({ nodes: [{ b: 1, a: 2 }], links: [] }), legacyHashCanvas({ links: [], nodes: [{ a: 2, b: 1 }] }));
});
