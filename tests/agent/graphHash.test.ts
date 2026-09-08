import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalGraph, graphHash } from '../../src/components/agent/graphHash';

test('graphHash ignores key order but not content', async () => {
  const graph = (n: number) => ({ nodes: [{ id: 1, widgets_values: [n] }], links: [[1, 2]] });
  assert.equal(await graphHash({ nodes: [{ id: 1, b: { c: 2, d: 3 } }], links: [] }), await graphHash({ links: [], nodes: [{ b: { d: 3, c: 2 }, id: 1 }] }));
  assert.notEqual(await graphHash(graph(1)), await graphHash(graph(2)));
  assert.notEqual(await graphHash({ nodes: [], links: [] }), await graphHash({ nodes: [{ id: 1 }], links: [] }));
});

test('graphHash covers only the graph, so metadata rewrites are not canvas edits', async () => {
  const nodes = [{ id: 1, type: 'KSampler' }], links = [[1, 2]];
  assert.equal(await graphHash({ nodes, links, extra: { name: '海报' } }), await graphHash({ nodes, links, extra: { name: '海报', tags: ['cloud'], comfy_mobile_cloud: { workflow_id: 'x' } } }));
  assert.equal(await graphHash({ nodes, links }), await graphHash({ nodes, links, extra: { ds: { scale: 2 } }, version: 0.4 }));
  assert.notEqual(await graphHash({ nodes, links, extra: {} }), await graphHash({ nodes: [...nodes, { id: 2 }], links, extra: {} }));
  assert.equal(await graphHash(undefined), await graphHash({}), 'a missing canvas hashes like an empty graph');
});

test('graphHash is a 64-character hex SHA-256 digest', async () => {
  assert.match(await graphHash({ nodes: [], links: [] }), /^[0-9a-f]{64}$/);
  assert.equal(canonicalGraph({ nodes: [{ b: 1, a: 2 }] }), '{"links":[],"nodes":[{"a":2,"b":1}]}');
});
