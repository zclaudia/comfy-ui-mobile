import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudFileContent, readCloudSaveOpId, readCloudWorkflowId, resolveCloudWorkflowId, stableCloudId } from '../../src/infrastructure/sync/cloudIdentity';

test('resolveCloudWorkflowId prefers the file id, then the cached id, then the filename hash', () => {
  assert.deepEqual(resolveCloudWorkflowId({ fileWorkflowId: 'wf-1', filename: 'a.json', existing: [] }), { id: 'wf-1', identityConflict: false });
  assert.deepEqual(resolveCloudWorkflowId({ cachedId: 'old', filename: 'a.json', existing: [{ id: 'old', filename: 'a.json' }] }), { id: 'old', identityConflict: false });
  assert.deepEqual(resolveCloudWorkflowId({ filename: 'a.json', existing: [] }), { id: stableCloudId('a.json'), identityConflict: false });
});

test('a cached entry adopts the file id once nobody else holds it, so devices converge', () => {
  const resolved = resolveCloudWorkflowId({ cachedId: stableCloudId('a.json'), fileWorkflowId: 'wf-1', filename: 'a.json', existing: [{ id: stableCloudId('a.json'), filename: 'a.json' }] });
  assert.deepEqual(resolved, { id: 'wf-1', identityConflict: false });
});

test('a file copied on the server cannot steal the original id and is flagged for re-linking', () => {
  const copy = resolveCloudWorkflowId({ fileWorkflowId: 'wf-1', filename: 'a (copy).json', existing: [{ id: 'wf-1', filename: 'a.json' }] });
  assert.deepEqual(copy, { id: stableCloudId('a (copy).json'), identityConflict: true });
  const cachedCopy = resolveCloudWorkflowId({ cachedId: 'local-copy', fileWorkflowId: 'wf-1', filename: 'a (copy).json', existing: [{ id: 'wf-1', filename: 'a.json' }, { id: 'local-copy', filename: 'a (copy).json' }] });
  assert.deepEqual(cachedCopy, { id: 'local-copy', identityConflict: true });
});

test('renaming a file on the server keeps its id because the id lives inside the file', () => {
  const before = resolveCloudWorkflowId({ fileWorkflowId: 'wf-1', filename: 'a.json', existing: [] });
  const after = resolveCloudWorkflowId({ fileWorkflowId: 'wf-1', filename: 'b.json', existing: [] });
  assert.equal(before.id, after.id);
  assert.notEqual(stableCloudId('a.json'), stableCloudId('b.json'));
});

test('cloudFileContent writes schema 2 and the readers accept schema 1 files too', () => {
  const content = cloudFileContent({ nodes: [], links: [], extra: { ds: 1 } } as never, { name: '海报', workflowId: 'wf-1', saveOpId: 'op-1' });
  assert.deepEqual(content.extra.comfy_mobile_cloud, { schema: 2, workflow_id: 'wf-1', save_op_id: 'op-1' });
  assert.equal(content.extra.ds, 1);
  assert.equal(readCloudWorkflowId(content), 'wf-1');
  assert.equal(readCloudSaveOpId(content), 'op-1');
  assert.equal(readCloudWorkflowId({ extra: { comfy_mobile_cloud: { schema: 1, workflow_id: 'legacy' } } }), 'legacy');
  assert.equal(readCloudWorkflowId({ extra: { comfy_mobile_cloud: { workflow_id: '' } } }), undefined);
  assert.equal(readCloudWorkflowId({ nodes: [] }), undefined);
  assert.equal(readCloudSaveOpId(undefined), undefined);
});
