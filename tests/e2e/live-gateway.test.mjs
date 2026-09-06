import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import WebSocket from 'ws';

const gatewayUrl = (process.env.LIVE_GATEWAY_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const gatewayToken = process.env.GATEWAY_AUTH_TOKEN?.trim();
const inputImage = process.env.LIVE_COMFY_INPUT_IMAGE || 'example.png';
const keepOutput = process.env.LIVE_KEEP_OUTPUT === 'true';
const allowCleanup = process.env.LIVE_ALLOW_CLEANUP === 'true';
const expectedCookieSameSite = process.env.LIVE_EXPECT_COOKIE_SAMESITE || 'Strict';

if (!gatewayToken) {
  throw new Error('GATEWAY_AUTH_TOKEN is required for the live Gateway test');
}

const authHeaders = { Authorization: `Bearer ${gatewayToken}` };

const request = async (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: {
    ...authHeaders,
    ...(options.headers || {}),
  },
});

const readJson = async (response) => {
  const body = await response.json();
  assert.ok(response.ok, `${response.url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const deleteImages = async (images) => {
  const response = await request('/comfymobile/api/files/delete', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: images }),
  });
  const body = await readJson(response);
  assert.equal(body.status, 'success');
};

const connectExecutionSocket = async (clientId) => {
  const websocketUrl = new URL(gatewayUrl);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  websocketUrl.pathname = '/ws';
  websocketUrl.search = `?clientId=${encodeURIComponent(clientId)}`;

  const socket = new WebSocket(websocketUrl, { headers: authHeaders });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out connecting to Gateway WebSocket')), 10_000);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return socket;
};

const waitForPromptCompletion = (socket, expectedPromptId) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for prompt ${expectedPromptId}`));
  }, 45_000);

  const finish = (callback, value) => {
    clearTimeout(timeout);
    socket.off('message', onMessage);
    callback(value);
  };

  const onMessage = (raw, isBinary) => {
    if (isBinary) return;

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const promptId = message.data?.prompt_id;
    if (promptId !== expectedPromptId) return;

    if (message.type === 'execution_error' || message.type === 'execution_interrupted') {
      finish(reject, new Error(`Prompt failed: ${JSON.stringify(message.data)}`));
      return;
    }

    if (
      message.type === 'execution_success'
      || (message.type === 'executing' && message.data?.node === null)
    ) {
      finish(resolve, message);
    }
  };

  socket.on('message', onMessage);
});

test('live Gateway and ComfyUI end-to-end', { timeout: 90_000 }, async (t) => {
  await t.test('health is public and ComfyUI routes require authentication', async () => {
    const health = await fetch(`${gatewayUrl}/api/gateway/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const version = await fetch(`${gatewayUrl}/version.json`);
    assert.equal(version.status, 200);
    assert.match(version.headers.get('content-type') || '', /^application\/json/);
    assert.match((await version.json()).version || '', /^\d+\.\d+\.\d+$/);

    const unauthenticated = await fetch(`${gatewayUrl}/object_info`);
    assert.equal(unauthenticated.status, 401);
  });

  await t.test('browser session login and logout work', async () => {
    const login = await fetch(`${gatewayUrl}/api/gateway/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: gatewayToken, remember: false }),
    });
    assert.equal(login.status, 200);

    const cookie = login.headers.get('set-cookie');
    assert.match(cookie || '', /comfy_mobile_session=/);
    assert.match(cookie || '', /HttpOnly/i);
    assert.match(cookie || '', new RegExp(`SameSite=${expectedCookieSameSite}`, 'i'));
    if (expectedCookieSameSite.toLowerCase() === 'none') {
      assert.match(cookie || '', /Secure/i);
    }

    const session = await fetch(`${gatewayUrl}/api/gateway/session`, {
      headers: { Cookie: cookie },
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).authenticated, true);

    const logout = await fetch(`${gatewayUrl}/api/gateway/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') || '', /Max-Age=0/i);
  });

  await t.test('allowlisted APIs are reachable and dangerous APIs remain denied', async () => {
    const [systemStats, objectInfo, extensionStatus] = await Promise.all([
      request('/system_stats').then(readJson),
      request('/object_info').then(readJson),
      request('/comfymobile/api/status').then(readJson),
    ]);

    assert.ok(systemStats.system);
    assert.ok(objectInfo.LoadImage);
    assert.ok(objectInfo.SaveImage);
    assert.ok(extensionStatus.version || extensionStatus.status);

    const dangerous = await request('/comfymobile/api/reboot', { method: 'POST' });
    assert.equal(dangerous.status, 403);

    const unknown = await request('/internal/folder_paths');
    assert.equal(unknown.status, 404);
  });

  await t.test('image upload and authenticated retrieval work through the Gateway', async () => {
    const testFilename = 'comfy-mobile-e2e-upload.png';
    const imageBytes = await readFile(new URL('../../public/favicon-32x32.png', import.meta.url));
    const form = new FormData();
    form.append('image', new Blob([imageBytes], { type: 'image/png' }), testFilename);
    form.append('type', 'input');
    form.append('subfolder', '');
    form.append('overwrite', 'true');

    const uploaded = await readJson(await request('/upload/image', {
      method: 'POST',
      body: form,
    }));
    assert.equal(uploaded.name, testFilename);

    const params = new URLSearchParams({
      filename: uploaded.name,
      subfolder: uploaded.subfolder || '',
      type: uploaded.type || 'input',
    });
    const media = await request(`/view?${params}`);
    assert.equal(media.status, 200);
    assert.match(media.headers.get('content-type') || '', /^image\//);

    if (allowCleanup) {
      await deleteImages([{
        filename: uploaded.name,
        subfolder: uploaded.subfolder || '',
        type: uploaded.type || 'input',
      }]);
    } else {
      t.diagnostic(`Kept reusable upload fixture: ${JSON.stringify(uploaded)}`);
    }
  });

  await t.test('prompt executes over WebSocket and output is available in history', async () => {
    const clientId = randomUUID();
    const requestedPromptId = randomUUID();
    const filenamePrefix = `ComfyMobileE2E/${requestedPromptId}`;
    const workflow = {
      last_node_id: 2,
      last_link_id: 1,
      nodes: [
        {
          id: 1,
          type: 'LoadImage',
          pos: [0, 0],
          size: [315, 314],
          flags: {},
          order: 0,
          mode: 0,
          inputs: [],
          outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [1], slot_index: 0 }],
          properties: { 'Node name for S&R': 'LoadImage' },
          widgets_values: [inputImage, 'image'],
        },
        {
          id: 2,
          type: 'SaveImage',
          pos: [400, 0],
          size: [315, 270],
          flags: {},
          order: 1,
          mode: 0,
          inputs: [{ name: 'images', type: 'IMAGE', link: 1 }],
          outputs: [],
          properties: {},
          widgets_values: [filenamePrefix],
        },
      ],
      links: [[1, 1, 0, 2, 0, 'IMAGE']],
      groups: [],
      config: {},
      extra: {},
      version: 0.4,
    };
    const prompt = {
      1: { class_type: 'LoadImage', inputs: { image: inputImage } },
      2: {
        class_type: 'SaveImage',
        inputs: { images: ['1', 0], filename_prefix: filenamePrefix },
      },
    };

    const socket = await connectExecutionSocket(clientId);
    try {
      const completion = waitForPromptCompletion(socket, requestedPromptId);
      const submission = await readJson(await request('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          client_id: clientId,
          prompt_id: requestedPromptId,
          extra_data: { extra_pnginfo: { workflow } },
        }),
      }));
      assert.equal(submission.prompt_id, requestedPromptId);

      await completion;

      const history = await readJson(await request(`/history/${requestedPromptId}`));
      const run = history[requestedPromptId];
      assert.ok(run, 'Completed prompt is missing from history');
      const output = run.outputs?.['2']?.images?.[0];
      assert.ok(output?.filename, 'SaveImage output is missing from history');

      const params = new URLSearchParams({
        filename: output.filename,
        subfolder: output.subfolder || '',
        type: output.type || 'output',
      });
      const media = await request(`/view?${params}`);
      assert.equal(media.status, 200);
      assert.match(media.headers.get('content-type') || '', /^image\//);
      assert.ok((await media.arrayBuffer()).byteLength > 0);

      if (!keepOutput && allowCleanup) {
        await deleteImages([{
          filename: output.filename,
          subfolder: output.subfolder || '',
          type: output.type || 'output',
        }]);
      } else {
        t.diagnostic(`Kept output for UI verification: ${JSON.stringify(output)}`);
      }
    } finally {
      socket.close();
    }
  });

  await t.test('video prompt produces a playable MP4 through the Gateway', async () => {
    const clientId = randomUUID();
    const requestedPromptId = randomUUID();
    const filenamePrefix = `ComfyMobileE2E/Video/${requestedPromptId}`;
    const prompt = {
      1: {
        class_type: 'EmptyImage',
        inputs: { width: 320, height: 240, batch_size: 2, color: 0xff0000 },
      },
      2: {
        class_type: 'EmptyImage',
        inputs: { width: 320, height: 240, batch_size: 2, color: 0x00ff00 },
      },
      3: {
        class_type: 'ImageBatch',
        inputs: { image1: ['1', 0], image2: ['2', 0] },
      },
      4: {
        class_type: 'EmptyImage',
        inputs: { width: 320, height: 240, batch_size: 2, color: 0x0000ff },
      },
      5: {
        class_type: 'ImageBatch',
        inputs: { image1: ['3', 0], image2: ['4', 0] },
      },
      6: {
        class_type: 'EmptyImage',
        inputs: { width: 320, height: 240, batch_size: 2, color: 0xffff00 },
      },
      7: {
        class_type: 'ImageBatch',
        inputs: { image1: ['5', 0], image2: ['6', 0] },
      },
      8: {
        class_type: 'CreateVideo',
        inputs: { images: ['7', 0], fps: 2 },
      },
      9: {
        class_type: 'SaveVideo',
        inputs: {
          video: ['8', 0],
          filename_prefix: filenamePrefix,
          format: 'mp4',
        },
      },
    };

    const socket = await connectExecutionSocket(clientId);
    try {
      const completion = waitForPromptCompletion(socket, requestedPromptId);
      const submission = await readJson(await request('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          client_id: clientId,
          prompt_id: requestedPromptId,
        }),
      }));
      assert.equal(submission.prompt_id, requestedPromptId);

      await completion;

      const history = await readJson(await request(`/history/${requestedPromptId}`));
      const run = history[requestedPromptId];
      assert.ok(run, 'Completed video prompt is missing from history');
      const output = run.outputs?.['9']?.images?.[0];
      assert.ok(output?.filename, 'SaveVideo output is missing from history');
      assert.match(output.filename, /\.mp4$/i);

      const params = new URLSearchParams({
        filename: output.filename,
        subfolder: output.subfolder || '',
        type: output.type || 'output',
      });
      const media = await request(`/view?${params}`);
      assert.equal(media.status, 200);
      assert.match(media.headers.get('content-type') || '', /^video\/mp4(?:;|$)/);
      assert.equal(media.headers.get('accept-ranges'), 'bytes');
      const videoBytes = new Uint8Array(await media.arrayBuffer());
      assert.ok(videoBytes.byteLength > 100, 'Generated MP4 is unexpectedly small');
      assert.equal(new TextDecoder().decode(videoBytes.slice(4, 8)), 'ftyp');

      if (!keepOutput && allowCleanup) {
        await deleteImages([{
          filename: output.filename,
          subfolder: output.subfolder || '',
          type: output.type || 'output',
        }]);
      } else {
        t.diagnostic(`Kept video output for UI verification: ${JSON.stringify(output)}`);
      }
    } finally {
      socket.close();
    }
  });
});
