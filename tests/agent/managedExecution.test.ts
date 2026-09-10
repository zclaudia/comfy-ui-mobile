import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
// The extension helper is intentionally independent of browser and ComfyUI modules.
import { installManagedExecution } from '../../comfy-mobile-ui-api-extension/fe/managedExecution.js';

test('official queue commands request a workspace execution without running the original queue or mutating seeds', async () => {
  let directSubmissions = 0; let requests = 0;
  const app = { seed: 42, queuePrompt: async () => { app.seed++; directSubmissions++; } };
  const api = { queuePrompt: async () => { directSubmissions++; } };
  const ready = installManagedExecution(app, api, () => { requests++; });
  assert.equal(ready(), true);
  await app.queuePrompt();
  assert.equal(requests, 1); assert.equal(directSubmissions, 0); assert.equal(app.seed, 42);
  await assert.rejects(api.queuePrompt(), /conversation/);
  assert.equal(directSubmissions, 0); assert.equal(requests, 1);
});

test('unsupported or replaced queue APIs cannot advertise managed execution readiness', () => {
  assert.equal(installManagedExecution({}, {}, () => undefined)(), false);
  const app = { queuePrompt: async () => undefined };
  const api = { queuePrompt: async () => undefined };
  const ready = installManagedExecution(app, api, () => undefined);
  api.queuePrompt = async () => undefined;
  assert.equal(ready(), false);
  assert.equal(installManagedExecution(app, Object.freeze(api), () => undefined)(), false);
});

test('official serialization preserves shell metadata and named-widget representation while retaining real edits', async () => {
  const original = { name: '', mobile_ui_metadata: { control_after_generate: { '8': 'fixed' }, custom: 'keep' }, nodes: [
    { id: 5, type: 'Text', widgets_values: ['cat'] },
    { id: 8, type: 'Sampler', widgets_values: [42, 'fixed'], widgets_values_named: { seed: 42, unknown: 'preserve' } },
  ] };
  const serialized = { nodes: [
    { id: 5, type: 'Text', widgets_values: ['cat'], widgets_values_named: { text: 'cat' } },
    { id: 8, type: 'Sampler', widgets_values: [42, 'fixed'], widgets_values_named: { seed: 42 } },
  ], extra: { ds: { scale: 1 } } };
  const inputSnapshot = structuredClone(original);
  let response!: { ok: boolean; data: unknown };
  const app = { graph: { _nodes: [{ id: 8, widgets: [{ name: 'seed', value: 43 }, { name: 'control_after_generate', value: 'increment' }] }], serialize: () => serialized },
    loadGraphData: async (workflow: { name?: string }) => { delete workflow.name; } };
  const window = { location: { search: '' }, self: {}, top: {}, parent: { postMessage: (message: { type: string; payload: typeof response }) => { if (message.type === 'response') response = message.payload; } } };
  window.top = window.self;
  const source = readFileSync(new URL('../../comfy-mobile-ui-api-extension/fe/mobileBridge.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const bridge = runInNewContext(source + '\n({ loadWorkflow, handleGetWorkflow })', { window, document: { referrer: '' }, app, api: {}, installManagedExecution, URL, URLSearchParams,
    requestAnimationFrame: (callback: () => void) => callback(), setTimeout: () => 0, console: { warn() {} } });
  await bridge.loadWorkflow({ workflow: original });
  serialized.extra.ds.scale = 2;
  await bridge.handleGetWorkflow('unchanged');
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), inputSnapshot, 'frontend normalization and viewport changes are not user edits');
  serialized.nodes[0].widgets_values = ['beach cat']; serialized.nodes[0].widgets_values_named.text = 'beach cat';
  serialized.nodes[1].widgets_values = [43, 'increment']; serialized.nodes[1].widgets_values_named.seed = 43;
  await bridge.handleGetWorkflow('save');
  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(response.data)), { name: '', extra: { ds: { scale: 2 } }, mobile_ui_metadata: { control_after_generate: { '8': 'increment' }, custom: 'keep' }, nodes: [
    { id: 5, type: 'Text', widgets_values: ['beach cat'] },
    { id: 8, type: 'Sampler', widgets_values: [43, 'increment'], widgets_values_named: { seed: 43, unknown: 'preserve' } },
  ] });
  assert.ok(serialized.nodes[0].widgets_values_named, 'serializer result is not mutated');
});


test('parent handoff enables execution ownership after router query loss and only after the workflow loads', async () => {
  const messages: { type: string; payload: { managedExecution?: boolean } }[] = [];
  let loads = 0; let complete!: () => void;
  const app = { graph: { _nodes: [] }, queuePrompt: async () => undefined, loadGraphData: async () => { loads++; await new Promise<void>(resolve => { complete = resolve; }); } };
  const api = { queuePrompt: async () => undefined };
  const window = { location: { search: '' }, self: {}, top: {}, parent: { postMessage: (message: typeof messages[number]) => messages.push(message) } };
  window.top = window.self; // Skip UI extension registration; exercise the actual handoff functions directly.
  const context = { window, document: { referrer: 'http://shell.test/chat' }, app, api, installManagedExecution, URL, URLSearchParams, console: { warn() {} } };
  const source = readFileSync(new URL('../../comfy-mobile-ui-api-extension/fe/mobileBridge.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const bridge = runInNewContext(source + '\n({ loadWorkflow, handleShellMessage, graphSummary })', context);
  assert.equal(bridge.graphSummary().managedExecution, false);
  bridge.handleShellMessage({ source: {}, origin: 'http://shell.test', data: { source: 'comfy-mobile-shell', type: 'load-workflow', payload: { workflow: {}, managedExecution: true } } });
  assert.equal(loads, 0, 'a same-origin sibling cannot send parent commands');
  const loading = bridge.loadWorkflow({ workflow: { nodes: [] }, managedExecution: true });
  assert.equal(loads, 1); assert.equal(bridge.graphSummary().managedExecution, false, 'guard installation alone does not prove the right workflow is loaded');
  complete(); await loading;
  assert.equal(bridge.graphSummary().managedExecution, true);
  await app.queuePrompt(); assert.equal(messages.at(-1)?.type, 'execution-requested');
  await assert.rejects(api.queuePrompt(), /conversation/);
  app.loadGraphData = async () => { throw new Error('invalid graph'); };
  await bridge.loadWorkflow({ workflow: { nodes: [] }, managedExecution: true });
  assert.equal(bridge.graphSummary().managedExecution, false, 'a failed subsequent handoff locks the official canvas');
});

test('managed media options are local to the loaded graph and available before official missing-media validation', async () => {
  const token = 'asset:25e13be5-7dbf-4319-aa68-635aa14389df';
  const values = ['ordinary.png'];
  const node = { type: 'LoadImage', widgets: [{ name: 'image', options: { values } }] };
  const window = { location: { search: '' }, self: {}, top: {}, parent: { postMessage() {} } }; window.top = window.self;
  const app = { graph: { _nodes: [node] }, queuePrompt: async () => undefined,
    loadGraphData: async () => { bridge.prepareManagedMediaNode(node); assert.ok(node.widgets[0].options.values.includes(token)); } };
  const source = readFileSync(new URL('../../comfy-mobile-ui-api-extension/fe/mobileBridge.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const bridge = runInNewContext(source + '\n({ loadWorkflow, prepareManagedMediaNode })', { window, document: { referrer: '' }, app,
    api: { queuePrompt: async () => undefined }, installManagedExecution, URL, URLSearchParams, console: { warn() {} } });
  bridge.prepareManagedMediaNode(node); assert.equal(node.widgets[0].options.values, values);
  await bridge.loadWorkflow({ managedExecution: true, workflow: { nodes: [{ type: 'LoadImage', widgets_values: [token] }, { type: 'LoadImage', widgets_values: ['../../private'] }] } });
  assert.deepEqual(values, ['ordinary.png'], 'shared node definitions are untouched');
  assert.deepEqual([...node.widgets[0].options.values], ['ordinary.png', token]);
  const dynamic = { type: 'LoadImage', widgets: [{ name: 'image', options: { values: () => values } }] };
  bridge.prepareManagedMediaNode(dynamic);
  assert.deepEqual([...dynamic.widgets[0].options.values()], ['ordinary.png', token]);
  const unrelated = { type: 'Text', widgets: [{ name: 'image', options: { values } }] };
  bridge.prepareManagedMediaNode(unrelated); assert.equal(unrelated.widgets[0].options.values, values);
});
