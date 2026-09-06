import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';

const gatewayUrl = (process.env.LIVE_GATEWAY_URL || 'https://comfy.zhvala.space:28443').replace(/\/$/, '');
const gatewayToken = process.env.GATEWAY_AUTH_TOKEN?.trim();
const inputImage = process.env.LIVE_COMFY_INPUT_IMAGE || 'example.png';

if (!gatewayToken) throw new Error('GATEWAY_AUTH_TOKEN is required');

const authHeaders = { Authorization: `Bearer ${gatewayToken}` };
const request = (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: { ...authHeaders, ...(options.headers || {}) },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = async (response) => {
  const body = await response.json();
  assert.ok(response.ok, `${response.url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const connectSocket = async (clientId) => {
  const url = new URL(gatewayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/ws';
  url.search = `?clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(url, { headers: authHeaders });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket connection timed out')), 10_000);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', reject);
  });
  return socket;
};

const waitForCompletion = (socket, promptId) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Prompt ${promptId} timed out`)), 60_000);
  const finish = (callback, value) => {
    clearTimeout(timeout);
    socket.off('message', onMessage);
    callback(value);
  };
  const onMessage = (raw, isBinary) => {
    if (isBinary) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.data?.prompt_id !== promptId) return;
    if (message.type === 'execution_error' || message.type === 'execution_interrupted') {
      finish(reject, new Error(`${message.type}: ${JSON.stringify(message.data)}`));
    } else if (
      message.type === 'execution_success'
      || (message.type === 'executing' && message.data?.node === null)
    ) {
      finish(resolve, message);
    }
  };
  socket.on('message', onMessage);
});

const collectFiles = (value, files = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, files);
  } else if (value && typeof value === 'object') {
    if (typeof value.filename === 'string') files.push(value);
    else for (const item of Object.values(value)) collectFiles(item, files);
  }
  return files;
};

const execute = async (prompt, outputNodeId) => {
  const clientId = randomUUID();
  const promptId = randomUUID();
  const socket = await connectSocket(clientId);
  try {
    const completion = waitForCompletion(socket, promptId);
    const submission = await readJson(await request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId, prompt_id: promptId }),
    }));
    assert.equal(submission.prompt_id, promptId);
    await completion;

    // History can arrive a fraction later than the final WebSocket message.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const history = await readJson(await request(`/history/${promptId}`));
      const files = collectFiles(history[promptId]?.outputs?.[outputNodeId]);
      if (files.length) return files;
      await sleep(250);
    }
    assert.fail(`Node ${outputNodeId} produced no files`);
  } finally {
    socket.close();
  }
};

const fetchOutput = async (file) => {
  const params = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder || '',
    type: file.type || 'output',
  });
  const response = await request(`/view?${params}`);
  assert.equal(response.status, 200);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || '',
  };
};

const emptyImage = (color, batchSize = 1) => ({
  class_type: 'EmptyImage',
  inputs: { width: 320, height: 240, batch_size: batchSize, color },
});

test('manual workflows execute through the public Gateway', { timeout: 180_000 }, async (t) => {
  await t.test('01 image load and save', async () => {
    const files = await execute({
      1: { class_type: 'LoadImage', inputs: { image: inputImage } },
      2: {
        class_type: 'SaveImage',
        inputs: { images: ['1', 0], filename_prefix: 'ManualTest/Image_Load_Save' },
      },
    }, '2');
    assert.equal(files.length, 1);
    const output = await fetchOutput(files[0]);
    assert.match(output.contentType, /^image\/png/);
    assert.deepEqual([...output.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  });

  await t.test('02 RGB image batch', async () => {
    const files = await execute({
      1: emptyImage(0xff0000),
      2: emptyImage(0x00ff00),
      3: emptyImage(0x0000ff),
      4: { class_type: 'ImageBatch', inputs: { image1: ['1', 0], image2: ['2', 0] } },
      5: { class_type: 'ImageBatch', inputs: { image1: ['4', 0], image2: ['3', 0] } },
      6: {
        class_type: 'SaveImage',
        inputs: { images: ['5', 0], filename_prefix: 'ManualTest/Image_Color_Batch' },
      },
    }, '6');
    assert.equal(files.length, 3);
    for (const file of files) assert.match((await fetchOutput(file)).contentType, /^image\/png/);
  });

  await t.test('03 H.264 MP4 color video', async () => {
    const files = await execute({
      1: emptyImage(0xff0000, 2),
      2: emptyImage(0x00ff00, 2),
      3: { class_type: 'ImageBatch', inputs: { image1: ['1', 0], image2: ['2', 0] } },
      4: emptyImage(0x0000ff, 2),
      5: { class_type: 'ImageBatch', inputs: { image1: ['3', 0], image2: ['4', 0] } },
      6: { class_type: 'CreateVideo', inputs: { images: ['5', 0], fps: 2 } },
      7: {
        class_type: 'SaveVideo',
        inputs: {
          video: ['6', 0],
          filename_prefix: 'ManualTest/Video_MP4_Color',
          format: 'mp4',
          codec: 'h264',
        },
      },
    }, '7');
    assert.equal(files.length, 1);
    assert.match(files[0].filename, /\.mp4$/i);
    const output = await fetchOutput(files[0]);
    assert.match(output.contentType, /^video\/mp4/);
    assert.equal(new TextDecoder().decode(output.bytes.slice(4, 8)), 'ftyp');
  });

  await t.test('04 VP9 WebM color video', async () => {
    const files = await execute({
      1: emptyImage(0xffff00, 2),
      2: emptyImage(0x00ffff, 2),
      3: { class_type: 'ImageBatch', inputs: { image1: ['1', 0], image2: ['2', 0] } },
      4: emptyImage(0xff00ff, 2),
      5: { class_type: 'ImageBatch', inputs: { image1: ['3', 0], image2: ['4', 0] } },
      6: {
        class_type: 'SaveWEBM',
        inputs: {
          images: ['5', 0],
          filename_prefix: 'ManualTest/Video_WEBM_Color',
          codec: 'vp9',
          fps: 2,
          crf: 32,
        },
      },
    }, '6');
    assert.equal(files.length, 1);
    assert.match(files[0].filename, /\.webm$/i);
    const output = await fetchOutput(files[0]);
    assert.match(output.contentType, /^video\/webm/);
    assert.deepEqual([...output.bytes.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3]);
  });
});
