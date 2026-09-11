import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyNode, sectionCategoryId, suggestControl, suggestFormSpec } from '@/core/services/FormSuggestionService';
import { resolveSpec, usableFieldCount } from '@/shared/utils/mobileForm';
import { makeGraph, makeNode, makeValueLayer, wanLikeGraph } from '../fixtures/formGraph';

const fieldsOf = (spec: any) => spec.sections.flatMap((section: any) =>
  section.fields.map((field: any) => `${field.target.nodeId}:${field.target.widget}`));

const widgetsFor = (node: any) => node.getWidgets();

test('node classification follows the stack view precedence', () => {
  const check = (seed: any) => {
    const node = makeNode(seed);
    return classifyNode(node, widgetsFor(node));
  };
  assert.equal(check({ id: 1, type: 'UNETLoader', widgets: [{ name: 'unet_name' }], outputs: [{ type: 'MODEL' }] }), 'models_loras');
  assert.equal(check({ id: 2, type: 'LoraLoader', widgets: [{ name: 'lora_name' }] }), 'models_loras');
  assert.equal(check({ id: 3, type: 'CheckpointLoaderSimple', widgets: [{ name: 'ckpt_name' }], outputs: [{ type: 'MODEL' }] }), 'models_loras');
  assert.equal(check({ id: 4, type: 'LoadCLIP', widgets: [{ name: 'clip_name' }] }), 'loaders');
  assert.equal(check({ id: 5, type: 'LoadImage', widgets: [{ name: 'image' }] }), 'inputs');
  assert.equal(check({ id: 6, type: 'EmptyLatentImage', widgets: [{ name: 'width' }, { name: 'height' }] }), 'inputs');
  assert.equal(check({ id: 7, type: 'CLIPTextEncode', title: 'prompt', widgets: [{ name: 'text', type: 'STRING' }] }), 'prompts');
  assert.equal(check({ id: 8, type: 'KSampler', widgets: [{ name: 'seed' }, { name: 'steps' }] }), 'samplers');
  assert.equal(check({ id: 9, type: 'SaveImage', widgets: [{ name: 'filename_prefix' }] }), 'outputs');
  assert.equal(check({ id: 10, type: 'Whatever', widgets: [{ name: 'mystery' }] }), 'uncategorized');
});

test('only the widgets worth a phone form are exposed, not every widget on a node', () => {
  const spec = suggestFormSpec(wanLikeGraph());
  const exposed = fieldsOf(spec);

  assert.ok(exposed.includes('4:steps'), 'steps is exposed');
  assert.ok(exposed.includes('4:cfg'), 'cfg is exposed');
  assert.ok(!exposed.includes('4:start_at_step'), 'the step-range plumbing stays off the form');
  assert.ok(!exposed.includes('4:end_at_step'));
  assert.ok(!exposed.includes('1:resize'), 'an unlisted boolean is not exposed by default');
  assert.ok(exposed.includes('1:image') && exposed.includes('1:width'));
  assert.ok(exposed.includes('7:filename_prefix'));
});

test('same-type widgets holding the same value merge into one linked field', () => {
  const spec = suggestFormSpec(wanLikeGraph());
  const all = spec.sections.flatMap((section) => section.fields);
  const steps = all.find((field) => field.target.widget === 'steps');

  assert.ok(steps, 'steps field exists');
  assert.deepEqual(steps!.linked?.map((target) => target.nodeId), [5], 'the two samplers share one steps field');
  assert.equal(all.filter((field) => field.target.widget === 'steps').length, 1);

  const seed = all.find((field) => field.target.widget === 'noise_seed');
  assert.deepEqual(seed!.linked?.map((target) => target.nodeId), [5], 'equal seeds merge too');
});

test('widgets the author deliberately set apart are left as separate fields', () => {
  const graph = makeGraph([
    { id: 1, type: 'KSampler', pos: [0, 0], widgets: [{ name: 'steps', type: 'INT', value: 20 }] },
    { id: 2, type: 'KSampler', pos: [0, 100], widgets: [{ name: 'steps', type: 'INT', value: 8 }] },
  ]);
  const fields = suggestFormSpec(graph).sections.flatMap((section) => section.fields);
  assert.equal(fields.length, 2, 'differing values are not merged');
  assert.ok(fields.every((field) => !field.linked));
});

test('a widget fed by a link is never suggested, because the form cannot set it', () => {
  const graph = makeGraph([
    { id: 1, type: 'CLIPTextEncode', title: 'prompt', widgets: [{ name: 'text', type: 'STRING', options: { multiline: true } }], connected: ['text'] },
    { id: 2, type: 'CLIPTextEncode', title: 'prompt', widgets: [{ name: 'text', type: 'STRING', options: { multiline: true } }] },
  ]);
  assert.deepEqual(fieldsOf(suggestFormSpec(graph)), ['2:text']);
});

test("sections take the author's group titles when a node sits inside one", () => {
  const spec = suggestFormSpec(wanLikeGraph());
  const titles = spec.sections.map((section) => section.title || sectionCategoryId(section.id));

  assert.ok(titles.includes('Scenario text'), 'the prompt group keeps its author-given name');
  assert.ok(titles.includes('High noise'));
  assert.ok(titles.includes('inputs'), 'ungrouped nodes fall back to a category id the UI translates');
  assert.equal(sectionCategoryId('cat:samplers'), 'samplers');
  assert.equal(sectionCategoryId('group:11'), null);
});

test('the suggested control matches the widget kind', () => {
  const control = (widget: any, category: any = 'samplers') => suggestControl(category, widget);
  assert.equal(control({ name: 'noise_seed', type: 'INT' }), 'seed');
  assert.equal(control({ name: 'text', type: 'STRING', options: { multiline: true } }, 'prompts'), 'textarea');
  assert.equal(control({ name: 'image', type: 'COMBO' }, 'inputs'), 'image');
  assert.equal(control({ name: 'cfg', type: 'FLOAT' }), 'slider');
  assert.equal(control({ name: 'steps', type: 'INT' }), 'stepper');
  assert.equal(control({ name: 'enabled', type: 'BOOLEAN' }), 'toggle');
  assert.equal(control({ name: 'sampler_name', type: 'COMBO' }), 'select');
});

test('a muted node contributes nothing, and every suggested field resolves', () => {
  const graph = makeGraph([
    { id: 1, type: 'KSampler', widgets: [{ name: 'steps', type: 'INT', value: 20 }] },
    { id: 2, type: 'LoadImage', mode: 2, widgets: [{ name: 'image', type: 'COMBO', value: 'a.png' }] },
  ]);
  const spec = suggestFormSpec(graph);
  assert.deepEqual(fieldsOf(spec), ['1:steps']);
  assert.equal(usableFieldCount(resolveSpec(graph, spec)), 1);
});

test('merging sees unsaved edits, so an edited-apart pair is not re-merged', () => {
  const graph = wanLikeGraph();
  const values = makeValueLayer();
  values.set(5, 'steps', 4);
  const fields = suggestFormSpec(graph, { getValue: values.get }).sections.flatMap((section) => section.fields);
  const steps = fields.filter((field) => field.target.widget === 'steps');
  assert.equal(steps.length, 2, 'the edited pair stays separate');
});

test('an empty or widget-less graph yields an empty spec rather than throwing', () => {
  assert.deepEqual(suggestFormSpec(null).sections, []);
  assert.deepEqual(suggestFormSpec(makeGraph([])).sections, []);
  assert.deepEqual(suggestFormSpec(makeGraph([{ id: 1, type: 'Reroute' }])).sections, []);
});
