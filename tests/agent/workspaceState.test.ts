import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspaceState, mergeEntities, mergeWorkspaceSnapshot, messageIdentity, targetContext, videoContext, withReference, workspaceTranscriptEvents } from '../../src/components/agent/workspace/state';
import { WorkspaceCommands } from '../../src/components/agent/workspace/commands';
import { verifiedImportSource } from '../../src/components/agent/workspace/importSource';
import type { Workflow } from '../../src/shared/types/app/IComfyWorkflow';
import type { Asset, Draft, Run, WorkspaceSnapshot } from '../../src/shared/types/agentWorkspace';
import type { AgentEvent } from '../../src/infrastructure/api/AgentApi';

const draft = (headRevision = 1): Draft => ({ id: 'image', sessionId: 'session', name: '猫咪', headRevision, outputKinds: ['image'], created: 1, updated: headRevision });
const run = (state: Run['state']): Run => ({ id: 'run', sessionId: 'session', draftId: 'image', revision: 1, state, outputAssetIds: [], created: 1 });
const asset: Asset = { id: 'old-image', sessionId: 'session', kind: 'image', name: '猫咪', origin: 'generated', sourceRunId: 'run', displayOrdinal: 2, captureState: 'ready', metadata: {}, created: 1 };
const event = (seq: number, kind: string, data: AgentEvent['data']): AgentEvent => ({ seq, kind, data, created: seq, taskId: 'task' });
const snapshot = (highWater: number, events: AgentEvent[] = [], drafts = [draft()]): WorkspaceSnapshot => ({ session: { id: 'session', name: '猫咪视频', created: 0, schemaVersion: 2 }, highWater, cursor: events.at(-1)?.seq ?? highWater, hasMore: false, events, tasks: [], drafts: { items: drafts }, runs: { items: [] }, questions: [] });

test('late entity reads and old event pages cannot overwrite newer run, head or asset evidence', () => {
  let state = mergeWorkspaceSnapshot(emptyWorkspaceState(), snapshot(5));
  state = mergeWorkspaceSnapshot(state, snapshot(10, [event(8, 'run_state', { run: run('succeeded') }), event(9, 'asset_ready', { asset })], [draft(5)]));
  state = mergeEntities(state, { drafts: [draft(2)], runs: [run('running')], assets: [{ ...asset, captureState: 'pending_capture' }] }, 5);
  state = mergeWorkspaceSnapshot(state, snapshot(6, [event(6, 'run_state', { run: run('queued') })], [draft(2)]));
  assert.equal(state.drafts.image.headRevision, 5); assert.equal(state.runs.run.state, 'succeeded'); assert.equal(state.assets[asset.id].captureState, 'ready');
  assert.equal(state.highWater, 10); assert.equal(state.cursor, 9); assert.equal(state.snapshot!.highWater, 10);
  assert.deepEqual(state.events.map(event => event.seq), [6, 8, 9]);
});

test('revision events update drafts outside the recent snapshot page, including their output kinds', () => {
  let state = mergeWorkspaceSnapshot(emptyWorkspaceState(), snapshot(1));
  const changed = { ...draft(6), outputKinds: ['video'] as Draft['outputKinds'] };
  state = mergeWorkspaceSnapshot(state, snapshot(12, [event(12, 'revision_created', { draftId: 'image', revision: 6, draft: changed })], []));
  assert.equal(state.drafts.image.headRevision, 6); assert.deepEqual(state.drafts.image.outputKinds, ['video']);
  state = mergeWorkspaceSnapshot(state, snapshot(13, [event(12, 'revision_created', { draftId: 'image', revision: 6, draft: changed })], []));
  assert.equal(state.events.length, 1);
});

test('switching sessions clears all objects, and foreign asynchronous reads are ignored', () => {
  let state = mergeWorkspaceSnapshot(emptyWorkspaceState(), snapshot(20, [event(20, 'run_state', { run: run('succeeded') })]));
  const other = snapshot(1, [], []); other.session.id = 'other';
  state = mergeWorkspaceSnapshot(state, other);
  state = mergeEntities(state, { assets: [asset], drafts: [draft()], runs: [run('succeeded')] }, 30);
  assert.deepEqual(state.events, []); assert.deepEqual(state.assets, {}); assert.deepEqual(state.runs, {}); assert.deepEqual(state.drafts, {});
});

test('one evolving run card retains tool calls, individual batches and user context', () => {
  const events = [event(1, 'user', { context: { selectedAssetIds: [asset.id] } }), event(2, 'tool_start', {}), event(3, 'run_state', { run: run('queued') }), event(4, 'run_state', { run: run('running') }), event(5, 'tool_end', {}), event(6, 'workspace_result', { run: run('succeeded') }), event(7, 'run_state', { run: { ...run('succeeded'), id: 'second-run' } })];
  assert.deepEqual(workspaceTranscriptEvents(events).map(event => event.seq), [1, 2, 3, 5, 7]);
});

test('editing an old result and selecting reference images preserve separate explicit identities', () => {
  const target = targetContext({ draftId: 'video', revision: 2 });
  const selected = withReference(target, asset.id);
  assert.equal(selected.targetDraftId, 'video'); assert.equal(selected.sourceRevision, 2);
  assert.deepEqual(selected.selectedAssetIds, [asset.id]); assert.equal(target.selectedAssetIds, undefined);
  assert.deepEqual(withReference(selected, asset.id), selected);
  assert.deepEqual(videoContext(asset), { selectedAssetIds: [asset.id], action: 'generate_video' });
  assert.throws(() => videoContext({ ...asset, kind: 'video' }));
  assert.throws(() => withReference({ selectedAssetIds: Array.from({ length: 8 }, (_, i) => String(i)) }, 'ninth'));
  assert.notEqual(messageIdentity('继续', selected, []), messageIdentity('继续', { ...selected, sourceRevision: 5 }, []));
  assert.notEqual(messageIdentity('继续', selected, ['file1']), messageIdentity('继续', selected, ['file2']));
});

test('a lost restore reply retries the original CAS payload; a later explicit repeat gets a new request id', async () => {
  const commands = new WorkspaceCommands(); const sends: { requestId: string; input: { head: number; source: number } }[] = [];
  let fail = true;
  const send = async (input: { head: number; source: number }, requestId: string) => { sends.push({ input, requestId }); if (fail) { fail = false; throw new Error('reply lost'); } return { revision: 6 }; };
  await assert.rejects(commands.run('restore:image:2', { head: 5, source: 2 }, send));
  assert.equal((await commands.run('restore:image:2', { head: 6, source: 2 }, send)).revision, 6);
  assert.deepEqual(sends[1], sends[0]);
  await commands.run('restore:image:2', { head: 6, source: 2 }, send);
  assert.notEqual(sends[2].requestId, sends[1].requestId); assert.equal(sends[2].input.head, 6);
});

test('a cached cloud filename cannot silently become a source on a different server', () => {
  const workflow = { id: 'workflow', name: '猫', cloud: { filename: 'cat.json', etag: 'old' } } as Workflow;
  const content = { extra: { comfy_mobile_cloud: { workflow_id: workflow.id } } };
  assert.equal(verifiedImportSource(workflow, 'server', { success: true, etag: 'new', content }), undefined);
  assert.equal(verifiedImportSource(workflow, 'server', { success: true, etag: 'old', content: {} }), undefined);
  assert.equal(verifiedImportSource(workflow, 'server', { success: false }), undefined);
  assert.equal(verifiedImportSource(workflow, undefined, { success: true, etag: 'old', content }), undefined);
  assert.deepEqual(verifiedImportSource(workflow, 'server', { success: true, etag: 'old', content }), { serverId: 'server', workflowId: 'workflow', filename: 'cat.json', name: '猫', etag: 'old' });
});
