import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceSummary } from '../../src/components/agent/workspace/summary';
import { emptyWorkspaceState, mergeEntities, mergeWorkspaceSnapshot } from '../../src/components/agent/workspace/state';
import type { Draft, Run, WorkspaceSnapshot } from '../../src/shared/types/agentWorkspace';

const draft = (id: string, patch: Partial<Draft> = {}): Draft => ({ id, sessionId: 'session', name: id, headRevision: 1, outputKinds: ['image'], created: 1, updated: 1, ...patch });
const run = (id: string, draftId: string, patch: Partial<Run> = {}): Run => ({ id, sessionId: 'session', draftId, revision: 1, state: 'succeeded', outputAssetIds: [], created: 1, ...patch });
const snapshot = (drafts: Draft[], runs: Run[], pages: { drafts?: number; runs?: number } = {}): WorkspaceSnapshot => ({
  session: { id: 'session', name: '猫咪视频', created: 0, schemaVersion: 2 }, highWater: 1, cursor: 1, hasMore: false, events: [], tasks: [], questions: [],
  drafts: { items: drafts, nextCursor: pages.drafts }, runs: { items: runs, nextCursor: pages.runs },
});

test('every worked-on draft is listed newest first, with its own newest output as the thumbnail', () => {
  const state = mergeWorkspaceSnapshot(emptyWorkspaceState(), snapshot(
    [draft('cat', { updated: 10 }), draft('dog', { updated: 30 }), draft('fish', { updated: 50, archivedAt: 60 })],
    [run('cat-old', 'cat', { created: 5, outputAssetIds: ['cat-1'] }), run('cat-new', 'cat', { created: 20, outputAssetIds: ['cat-2', 'cat-3'] }), run('dog-run', 'dog', { created: 40, outputAssetIds: ['dog-1'] })],
  ));
  const summary = workspaceSummary(state);
  assert.deepEqual(summary.drafts.map(item => item.draft.id), ['dog', 'cat', 'fish']); // archived sinks below live drafts
  assert.deepEqual(summary.drafts.map(item => item.thumbnailAssetId), ['dog-1', 'cat-2', undefined]);
  assert.deepEqual(summary.drafts.map(item => item.outputCount), [1, 3, 0]);
  assert.equal(summary.drafts[1].latestRun?.id, 'cat-new');
  assert.deepEqual(summary.outputs, ['dog-1', 'cat-2', 'cat-3', 'cat-1']); // newest run first, each run's outputs in order
  assert.equal(summary.moreDrafts, false); assert.equal(summary.moreOutputs, false);
});

test('a draft whose run finished only in the event stream reports the finished run, not the page copy', () => {
  const stale = run('cat-run', 'cat', { created: 20, state: 'running' });
  let state = mergeWorkspaceSnapshot(emptyWorkspaceState(), snapshot([draft('cat', { latestRun: stale })], []));
  assert.equal(workspaceSummary(state).drafts[0].latestRun?.state, 'running');
  state = mergeEntities(state, { runs: [{ ...stale, state: 'succeeded', outputAssetIds: ['cat-1'] }] }, 2);
  const summary = workspaceSummary(state);
  assert.equal(summary.drafts[0].latestRun?.state, 'succeeded');
  assert.deepEqual(summary.outputs, ['cat-1']);
});

test('unloaded pages are reported so the counts read as partial, and an empty session summarises to nothing', () => {
  const state = mergeWorkspaceSnapshot(emptyWorkspaceState(), snapshot([draft('cat')], [], { drafts: 3, runs: 7 }));
  const summary = workspaceSummary(state);
  assert.equal(summary.moreDrafts, true); assert.equal(summary.moreOutputs, true);
  const empty = workspaceSummary(emptyWorkspaceState());
  assert.deepEqual(empty.drafts, []); assert.deepEqual(empty.outputs, []); assert.equal(empty.moreDrafts, false);
});
