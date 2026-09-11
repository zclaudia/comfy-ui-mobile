import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { applyPromptPatch, validatePrompt, WorkflowError } from '../engine.js';
import type { ObjectInfo, Prompt } from '../engine.js';
import { applyCanvasPatch, canvasToPrompt, promptToCanvas } from '../canvas.js';
import type { Canvas } from '../canvas.js';
import { ComfyAdapter, ComfyRequestError } from '../comfyAdapter.js';

test('official H3 serialization retains auto encoding with both nested and legacy codec defaults', async () => {
  const canvas: Canvas = JSON.parse(await readFile(new URL('../../../tests/fixtures/workspace-official-h3-canvas.json', import.meta.url), 'utf8'));
  const metadata: ObjectInfo = JSON.parse(await readFile(new URL('../../agent/test/model-fixtures/object-info.json', import.meta.url), 'utf8'));
  const prompt = canvasToPrompt(canvas, metadata, false);
  assert.deepEqual(prompt['16'].inputs, { video: ['15', 0], filename_prefix: 'ComfyMobile/Agent/h3-ref-image', format: 'auto', codec: 'auto' });
  assert.equal(prompt['17'].inputs.image, 'asset:00000000-0000-4000-8000-000000000001');
  const save = canvas.nodes.find(node => node.type === 'SaveVideo')!;
  save.widgets_values![3] = 'h264';
  assert.throws(() => canvasToPrompt(canvas, metadata, false), /Advanced SaveVideo/, 'unadapted encoding values must not be silently ignored');
  save.widgets_values![3] = 'auto'; save.widgets_values![1] = 'mp4';
  assert.throws(() => canvasToPrompt(canvas, metadata, false), /Advanced SaveVideo/);
});

const info: ObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['v1-5-pruned-emaonly-fp16.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  CLIPTextEncode: { input: { required: { text: ['STRING'], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  EmptyLatentImage: { input: { required: { width: ['INT', { min: 64, max: 4096 }], height: ['INT', { min: 64, max: 4096 }], batch_size: ['INT', { min: 1, max: 8 }] } }, output: ['LATENT'] },
  KSampler: { input: { required: {
    model: ['MODEL'], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'],
    seed: ['INT', { min: 0 }], steps: ['INT', { min: 1, max: 100 }], cfg: ['FLOAT', { min: 0, max: 100 }],
    sampler_name: [['euler']], scheduler: [['normal']], denoise: ['FLOAT', { min: 0, max: 1 }],
  } }, output: ['LATENT'] },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [], output_node: true },
};
const sample = JSON.parse(await readFile(new URL('../../../tests/samples/workflows/sample-workflow.json', import.meta.url), 'utf8')) as Canvas;
const original = canvasToPrompt(sample, info);
const codes = (prompt: unknown) => validatePrompt(prompt, info).map(d => d.code);

test('real sample imports correct seed widget offsets and connections', () => {
  assert.equal(original['3'].inputs.seed, 156680208700286);
  assert.equal(original['3'].inputs.steps, 20);
  assert.equal(original['3'].inputs.cfg, 8);
  assert.deepEqual(original['3'].inputs.model, ['4', 0]);
  assert.deepEqual(codes(original), []);
});

test('portrait edit round-trips preserving layout, metadata and UI-only widgets', () => {
  const before = structuredClone(sample);
  const updated = applyPromptPatch({ version: 2, prompt: original }, 2, [
    { op: 'set_input', nodeId: '5', input: 'height', value: 768 },
    { op: 'set_input', nodeId: '6', input: 'text', value: '日系动漫头像' },
  ], info);
  const canvas = promptToCanvas(sample, updated.prompt, info);
  assert.equal(updated.version, 3);
  assert.deepEqual(canvasToPrompt(canvas, info), updated.prompt);
  assert.deepEqual(canvas.extra, sample.extra);
  assert.deepEqual(canvas.nodes.map(n => n.pos), sample.nodes.map(n => n.pos));
  assert.equal(canvas.nodes.find(n => n.id === 3)!.widgets_values![1], 'randomize');
  assert.deepEqual(sample, before);
  assert.equal(original['5'].inputs.height, 512);
});

test('reconnection updates both canvas slot ends and link table', () => {
  const prompt = structuredClone(original);
  prompt['3'].inputs.positive = ['7', 0];
  const canvas = promptToCanvas(sample, prompt, info);
  assert.deepEqual(canvasToPrompt(canvas, info), prompt);
  assert.equal(canvas.nodes.find(n => n.id === 6)!.outputs![0].links, null);
  assert.equal(canvas.nodes.find(n => n.id === 7)!.outputs![0].links!.length, 2);
});

test('a missing model can be repaired without accepting an invalid final version', () => {
  const broken = structuredClone(sample);
  broken.nodes.find(n => n.id === 4)!.widgets_values![0] = 'missing.safetensors';
  const current = { version: 0, canvas: broken };
  const fixed = applyCanvasPatch(current, 0, [{ op: 'set_input', nodeId: '4', input: 'ckpt_name', value: 'v1-5-pruned-emaonly-fp16.safetensors' }], info);
  assert.deepEqual(codes(fixed.prompt), []);
  assert.deepEqual(canvasToPrompt(fixed.canvas, info), fixed.prompt);
  assert.equal(broken.nodes.find(n => n.id === 4)!.widgets_values![0], 'missing.safetensors');
  assert.throws(() => applyCanvasPatch(current, 0, [{ op: 'set_input', nodeId: '4', input: 'ckpt_name', value: 'still-missing' }], info), WorkflowError);
});

test('invalid batch and stale version leave original unchanged', () => {
  const current = { version: 4, prompt: structuredClone(original) };
  const before = structuredClone(current);
  assert.throws(() => applyPromptPatch(current, 4, [
    { op: 'set_input', nodeId: '6', input: 'text', value: 'changed' },
    { op: 'set_input', nodeId: '5', input: 'height', value: -10 },
  ], info), WorkflowError);
  assert.throws(() => applyPromptPatch(current, 3, [{ op: 'remove_node', nodeId: '5' }], info), /latest version/);
  assert.deepEqual(current, before);
});

test('add and reconnect in one patch, then remove old source atomically', () => {
  const result = applyPromptPatch({ version: 0, prompt: original }, 0, [
    { op: 'add_node', nodeId: '10', node: { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: 'new' } } },
    { op: 'set_input', nodeId: '3', input: 'positive', value: ['10', 0] },
    { op: 'remove_node', nodeId: '6' },
  ], info);
  assert.deepEqual(codes(result.prompt), []);
  assert.throws(() => promptToCanvas(sample, result.prompt, info), /not supported/);
  assert.throws(() => applyPromptPatch({ version: 0, prompt: original }, 0, [{ op: 'remove_node', nodeId: '4' }], info), /Missing source/);
});

test('diagnostics identify missing models, types, inputs, malformed links and ranges', () => {
  const cases: [string, (p: Prompt) => void][] = [
    ['invalid_choice', p => { p['4'].inputs.ckpt_name = 'not-installed'; }],
    ['missing_node', p => { p['4'].class_type = 'Unknown'; }],
    ['required_input', p => { delete p['3'].inputs.model; }],
    ['invalid_slot', p => { p['3'].inputs.model = ['4', 99]; }],
    ['incompatible_link', p => { p['3'].inputs.model = ['4', 1]; }],
    ['out_of_range', p => { p['3'].inputs.denoise = 2; }],
    ['invalid_number', p => { p['3'].inputs.steps = 1.5; }],
    ['unknown_input', p => { p['3'].inputs.typo = true; }],
    ['unsupported_literal', p => { p['3'].inputs.model = ['4', -1]; }],
  ];
  for (const [expected, mutate] of cases) {
    const prompt = structuredClone(original); mutate(prompt);
    assert.ok(codes(prompt).includes(expected), expected);
  }
});

test('cycles and missing output nodes are rejected', () => {
  const prompt = structuredClone(original);
  prompt['3'].inputs.latent_image = ['3', 0];
  assert.ok(codes(prompt).includes('cycle'));
  delete prompt['9'];
  assert.ok(codes(prompt).includes('missing_output'));
});

test('unsafe imported IDs and patch keys cannot affect prototypes', () => {
  const prompt = JSON.parse('{"__proto__":{"class_type":"SaveImage","inputs":{}}}');
  assert.ok(codes(prompt).includes('invalid_node'));
  assert.throws(() => applyPromptPatch({ version: 0, prompt: original }, 0, [
    { op: 'set_input', nodeId: '3', input: '__proto__', value: true },
  ], info), /Invalid input/);
});

test('unsupported canvas modes, nodes, subgraphs and dangling references fail explicitly', () => {
  for (const mutate of [
    (c: Canvas) => { c.nodes[0].mode = 4; },
    (c: Canvas) => { c.nodes[0].type = 'CustomNode'; },
    (c: Canvas) => { c.subgraphs = []; },
    (c: Canvas) => { c.links.pop(); },
    (c: Canvas) => { c.links[0][4] = 99; },
  ]) {
    const canvas = structuredClone(sample); mutate(canvas);
    assert.throws(() => canvasToPrompt(canvas, info), WorkflowError);
  }
});

test('adapter uses configured auth, validates before submit and preserves execution metadata', async t => {
  const requests: { path: string; body?: Record<string, any> }[] = [];
  let mode = 'success';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ path: req.url!, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url!.startsWith('/object_info')) return res.end(JSON.stringify(info));
    if (req.url!.startsWith('/prompt')) {
      if (mode === 'reject') { res.statusCode = 400; return res.end(JSON.stringify({ node_errors: { '3': { errors: ['bad input'] } } })); }
      if (mode === 'disconnect') { req.socket.destroy(); return; }
      return res.end(JSON.stringify({ prompt_id: 'run-1', number: 2 }));
    }
    res.end(JSON.stringify({}));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = new ComfyAdapter({ comfyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, comfyAuthToken: 'private-token' });
  assert.deepEqual(await adapter.getObjectInfo(), info);
  const context = { clientId: 'client-1', taskId: 'task-1', version: 3, workflow: sample };
  await assert.rejects(adapter.submit({}, info, context), WorkflowError);
  assert.equal(requests.length, 2, 'object_info plus the extension disk listing for loader enums');
  assert.deepEqual(await adapter.submit(original, info, context), { promptId: 'run-1', number: 2 });
  assert.ok(requests.every(r => new URL(r.path, 'http://localhost').searchParams.get('token') === 'private-token'));
  assert.deepEqual(requests[2].body!.extra_data.extra_pnginfo.workflow, sample);
  assert.deepEqual(requests[2].body!.extra_data.comfymobile_agent, { task_id: 'task-1', workflow_version: 3 });
  mode = 'reject';
  await assert.rejects(adapter.submit(original, info, context), (e: unknown) => e instanceof ComfyRequestError && e.status === 400 && !e.outcomeUncertain && !!(e.details as any).node_errors['3']);
  mode = 'disconnect';
  const before = requests.length;
  await assert.rejects(adapter.submit(original, info, context), (e: unknown) => e instanceof ComfyRequestError && e.outcomeUncertain && !e.message.includes('private-token'));
  assert.equal(requests.length, before + 1, 'must not retry an ambiguous POST');
  await adapter.getQueue();
  await adapter.getHistory('run-1');
  await assert.rejects(async () => adapter.getHistory('../queue'), /Invalid prompt ID/);
});

test('loader file choices merge the extension disk listing so freshly copied input files validate', async t => {
  const objectInfo: ObjectInfo = {
    LoadImage: { input: { required: { image: [['example.png']] } }, output: ['IMAGE'] },
    LoadAudio: { input: { required: { audio: [['ref_audio.wav']] } }, output: ['AUDIO'] },
  };
  let listingDisabled = false;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url!.startsWith('/comfymobile/api/files/list')) {
      if (listingDisabled) { res.statusCode = 404; return res.end('{}'); }
      return res.end(JSON.stringify({ status: 'success', images: [
        { filename: 'std_00001_.png', subfolder: 'ZI', type: 'input' },
        { filename: 'fresh.png', subfolder: '', type: 'input' },
        { filename: 'done.png', subfolder: 'x', type: 'output' },
        { filename: 'notes.txt', subfolder: '', type: 'input' },
      ], videos: [], files: [{ filename: 'voice.wav', subfolder: 'agent-chat', type: 'input' }] }));
    }
    return res.end(JSON.stringify(objectInfo));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = new ComfyAdapter({ comfyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
  const merged = await adapter.getObjectInfo();
  assert.deepEqual(merged.LoadImage!.input!.required!.image![0], ['ZI/std_00001_.png', 'example.png', 'fresh.png']);
  assert.deepEqual(merged.LoadAudio!.input!.required!.audio![0], ['agent-chat/voice.wav', 'ref_audio.wav']);
  assert.deepEqual(objectInfo.LoadImage!.input!.required!.image![0], ['example.png'], 'the served object info is never mutated');
  listingDisabled = true; // without the extension, validation falls back to the unpatched enums
  const degraded = await adapter.getObjectInfo();
  assert.deepEqual(degraded.LoadImage!.input!.required!.image![0], ['example.png']);
});

test('generated image copy uses authenticated multipart input upload and bounds chunked downloads', async t => {
  const image = Buffer.from('a generated image fixture');
  const received: { url: string; type?: string; body: Buffer }[] = [];
  let uploadName = 'renamed.png';
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push({ url: req.url!, type: req.headers['content-type'], body: Buffer.concat(chunks) });
    if (req.url!.startsWith('/view')) {
      res.setHeader('Content-Type', 'image/png');
      res.write(image.subarray(0, 4));
      return res.end(image.subarray(4));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: uploadName, subfolder: 'agent-chat/generated/test', type: 'input' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = new ComfyAdapter({ comfyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, comfyAuthToken: 'private-token' });
  const ref = { filename: 'cat.png', subfolder: 'A folder', type: 'output' };
  const file = await adapter.getFile(ref);
  assert.deepEqual(Buffer.from(file.bytes), image);
  assert.deepEqual(await adapter.uploadImage(file, 'copy.png', 'agent-chat/generated/test'), { filename: 'renamed.png', subfolder: 'agent-chat/generated/test', type: 'input' });
  assert.ok(received.every(r => new URL(r.url, 'http://localhost').searchParams.get('token') === 'private-token'));
  assert.equal(new URL(received[0].url, 'http://localhost').searchParams.get('subfolder'), ref.subfolder);
  const form = await new Response(received[1].body, { headers: { 'Content-Type': received[1].type! } }).formData();
  assert.equal(form.get('type'), 'input');
  assert.equal(form.get('subfolder'), 'agent-chat/generated/test');
  assert.equal(form.get('overwrite'), 'false');
  const uploadedFile = form.get('image') as File;
  assert.equal(uploadedFile.name, 'copy.png');
  assert.deepEqual(Buffer.from(await uploadedFile.arrayBuffer()), image);
  await assert.rejects(adapter.getFile(ref, undefined, 8), (e: unknown) => e instanceof ComfyRequestError && e.status === 413);
  uploadName = '../outside.png';
  await assert.rejects(adapter.uploadImage(file, 'copy.png', 'agent-chat/generated/test'), (e: unknown) => e instanceof ComfyRequestError && e.status === 502);
});
