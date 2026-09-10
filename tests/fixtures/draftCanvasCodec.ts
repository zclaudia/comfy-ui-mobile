import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGraphFromWorkflow, serializeGraph } from '../../src/core/services/WorkflowGraphService';
import { createModelWorkflow } from '../../gateway/agent/modelProfiles';
import { draftDiagnostics } from '../../gateway/agent/workspace/compiler';
import type { ObjectInfo } from '../../gateway/workflow/engine';
import { createExecutionGraph } from '../../src/core/services/WorkflowExecutionService';

test('a supported draft survives the actual mobile graph serializer and remains executable', async () => {
  const info: ObjectInfo = JSON.parse(readFileSync(`${process.cwd()}/gateway/agent/test/model-fixtures/object-info.json`, 'utf8'));
  const created = createModelWorkflow(info, { profileId: 'z-image-turbo', text: 'cat' });
  const prompt = created.nodes.find(node => node.id === 5)!;
  Object.assign(prompt, { widgets_values_named: { text: 'cat', unknown_extension_value: 'preserve' } });
  const graph = await createGraphFromWorkflow(created, info);
  const canvas = serializeGraph(graph);
  assert.deepEqual(draftDiagnostics(canvas, [], info), []);
  assert.equal(canvas.definitions, undefined);
  assert.equal(canvas.nodes.some((node: Record<string, unknown>) => '_widgets' in node || 'nodeData' in node), false);
  const modified = createExecutionGraph(graph, new Map([[5, { text: 'cat on beach' }]]));
  assert.equal(serializeGraph(modified).nodes.find((node: { id: number }) => node.id === 5).widgets_values[0], 'cat on beach');
  assert.deepEqual(serializeGraph(modified).nodes.find((node: { id: number }) => node.id === 5).widgets_values_named,
    { text: 'cat on beach', unknown_extension_value: 'preserve' });
  assert.equal(serializeGraph(graph).nodes.find((node: { id: number }) => node.id === 5).widgets_values[0], 'cat');
  assert.deepEqual(draftDiagnostics(serializeGraph(modified), [], info), []);
});

test('official H3 video with expanded dynamic controls remains editable through the mobile graph', async () => {
  const info: ObjectInfo = JSON.parse(readFileSync(`${process.cwd()}/gateway/agent/test/model-fixtures/object-info.json`, 'utf8'));
  const original = JSON.parse(readFileSync(`${process.cwd()}/tests/fixtures/workspace-official-h3-canvas.json`, 'utf8'));
  const bindings = [{ id: 'reference', nodeId: '17', inputName: 'image', role: 'reference_image', assetId: '00000000-0000-4000-8000-000000000001' }];
  const graph = await createGraphFromWorkflow(original, info);
  const edited = createExecutionGraph(graph, new Map([[7, { prompt: '<Picture 1> The cat waves beside the sea.' }]]));
  const canvas = serializeGraph(edited);
  assert.deepEqual(draftDiagnostics(canvas, bindings, info), []);
  assert.equal(canvas.nodes.find((node: { id: number }) => node.id === 7).widgets_values[0], '<Picture 1> The cat waves beside the sea.');
  assert.equal(canvas.nodes.find((node: { id: number }) => node.id === 17).widgets_values[0], `asset:${bindings[0].assetId}`);
});
