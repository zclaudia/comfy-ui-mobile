import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGraphFromWorkflow, serializeGraph } from '../../src/core/services/WorkflowGraphService';
import { createModelWorkflow } from '../../gateway/agent/modelProfiles';
import { draftDiagnostics } from '../../gateway/agent/workspace/compiler';
import type { ObjectInfo } from '../../gateway/workflow/engine';
import { createExecutionGraph } from '../../src/core/services/WorkflowExecutionService';
import { readFormSpec, writeFormSpec } from '../../src/shared/utils/mobileForm';

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

test('the mobile form spec survives the draft round trip, so a saved form is not lost in a chat', async () => {
  // The plan puts the spec in `extra` precisely because the mobile serializer
  // carries that through untouched; the gateway half is covered separately in
  // tests/agent/mobileFormDraft.test.ts.
  const info: ObjectInfo = JSON.parse(readFileSync(`${process.cwd()}/gateway/agent/test/model-fixtures/object-info.json`, 'utf8'));
  const spec = {
    version: 1 as const,
    mode: 'custom' as const,
    sections: [{ id: 's1', title: 'Prompt', fields: [{ id: 'f1', target: { nodeId: 5, widget: 'text', nodeType: 'CLIPTextEncode' } }] }],
    updatedAt: '2026-09-11T00:00:00.000Z',
  };
  const created = writeFormSpec(createModelWorkflow(info, { profileId: 'z-image-turbo', text: 'cat' }), spec);
  const canvas = serializeGraph(await createGraphFromWorkflow(created, info));
  assert.equal(readFormSpec(canvas)?.sections[0].fields[0].target.widget, 'text');
  assert.equal(readFormSpec(serializeGraph(createExecutionGraph(await createGraphFromWorkflow(created, info), new Map([[5, { text: 'edited' }]]))))?.mode, 'custom',
    'an executed copy of the draft still carries the form');
});

test('a KSampler whose widgets_values omits control_after_generate still maps to the right inputs', async () => {
  // Workflows authored before control_after_generate became its own widget —
  // and those exported by other tools — carry six values for a KSampler, not
  // seven. The widget list is still built with the synthesized control widget,
  // so every value after the seed used to shift by one: steps took cfg's value
  // and cfg took the sampler name, which the server rejects outright.
  const info: ObjectInfo = JSON.parse(readFileSync(`${process.cwd()}/gateway/agent/test/model-fixtures/object-info.json`, 'utf8'));
  const base = JSON.parse(readFileSync(`${process.cwd()}/tests/fixtures/form-view-workflow.json`, 'utf8'));
  const sampler = (workflow: Record<string, any>) => workflow.nodes.find((node: Record<string, any>) => node.type === 'KSampler');

  const canonical = sampler(base).widgets_values;
  assert.deepEqual(canonical, [2024, 'fixed', 8, 1, 'res_multistep', 'simple', 1], 'fixture drifted');

  const legacy = JSON.parse(JSON.stringify(base));
  delete sampler(legacy).widgets_values_named;
  sampler(legacy).widgets_values = [2024, 8, 1, 'res_multistep', 'simple', 1];

  const graph = await createGraphFromWorkflow(legacy, info);
  const node = graph._nodes.find((entry: { type: string }) => entry.type === 'KSampler');
  const widget = (name: string) => node.getWidget(name)?.value;

  assert.equal(widget('seed'), 2024);
  assert.equal(widget('steps'), 8, 'steps took the following value');
  assert.equal(widget('cfg'), 1);
  assert.equal(widget('sampler_name'), 'res_multistep');
  assert.equal(widget('scheduler'), 'simple');
  assert.equal(widget('denoise'), 1);
  assert.equal(widget('control_after_generate'), 'fixed', 'the synthesized control widget keeps its default');

  // The widget list and widgets_values must stay index-aligned, because
  // setWidgetValue writes back by widget position.
  node.setWidgetValue('steps', 12);
  assert.equal(serializeGraph(graph).nodes.find((entry: { type: string }) => entry.type === 'KSampler').widgets_values[2], 12,
    'an edit landed in the wrong widgets_values slot');
});

test('the canonical seven-value KSampler layout is untouched', async () => {
  const info: ObjectInfo = JSON.parse(readFileSync(`${process.cwd()}/gateway/agent/test/model-fixtures/object-info.json`, 'utf8'));
  const base = JSON.parse(readFileSync(`${process.cwd()}/tests/fixtures/form-view-workflow.json`, 'utf8'));
  const graph = await createGraphFromWorkflow(base, info);
  const node = graph._nodes.find((entry: { type: string }) => entry.type === 'KSampler');

  assert.equal(node.getWidget('steps')?.value, 8);
  assert.equal(node.getWidget('cfg')?.value, 1);
  assert.equal(node.getWidget('control_after_generate')?.value, 'fixed');
  assert.deepEqual(serializeGraph(graph).nodes.find((entry: { type: string }) => entry.type === 'KSampler').widgets_values,
    [2024, 'fixed', 8, 1, 'res_multistep', 'simple', 1], 'a correct workflow must not be rewritten');
});
