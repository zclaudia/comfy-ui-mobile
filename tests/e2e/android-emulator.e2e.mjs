// End-to-end test that drives the real Android app inside an emulator.
//
// Prerequisites:
//   - A booted AVD visible in `adb devices` (EMULATOR_SERIAL, default emulator-5554)
//   - The debug APK installed: app.comfymobile.client.debug
//   - A reachable Mobile Gateway (E2E_GATEWAY_URL) whose setup token is E2E_GATEWAY_TOKEN
//
// Run: npm run test:e2e:android
//
// The script talks to the app's WebView over the Chrome DevTools protocol, so
// every assertion exercises the same code path (Tauri http plugin scope,
// WebView cookie policy, Keystore device credentials) a physical phone uses.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const exec = promisify(execFile);

const serial = process.env.EMULATOR_SERIAL || 'emulator-5554';
const pkg = 'app.comfymobile.client.debug';
const activity = `${pkg}/app.comfymobile.client.MainActivity`;
const gatewayUrl = (process.env.E2E_GATEWAY_URL || 'https://comfy.zhvala.space:28443').replace(/\/$/, '');
const gatewayToken = process.env.E2E_GATEWAY_TOKEN?.trim();
const inputImage = process.env.E2E_COMFY_INPUT_IMAGE || 'example.png';

if (!gatewayToken) {
  throw new Error('E2E_GATEWAY_TOKEN is required (the Gateway setup token)');
}

const gwDecl = `const gw = ${JSON.stringify(gatewayUrl)};`;

const results = [];
const baselineActiveDeviceIds = new Set();
const testDeviceIds = new Set();
let activeTestDeviceId = null;
let imageOutput = null;
let videoOutput = null;
let appExecutionOutput = null;
const test = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error.message || error) });
    console.log(`  ✗ ${name}\n    ${error.message || error}`);
  }
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const adb = (...args) => exec('adb', ['-s', serial, ...args]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- WebView DevTools client ----------------------------------------------

const cdpUrl = async () => {
  const { stdout } = await adb('shell', 'pidof', pkg);
  const pid = stdout.trim().split(/\s+/)[0];
  assert(pid, 'app process not running');
  await adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);
  const pages = await (await fetch('http://127.0.0.1:9223/json')).json();
  const page = pages.find((p) => p.type === 'page' && p.url.startsWith('http://tauri.localhost'));
  assert(page, `no tauri.localhost page in ${JSON.stringify(pages.map((p) => p.url))}`);
  return page.webSocketDebuggerUrl;
};

const connect = async () => {
  const ws = new WebSocket(await cdpUrl());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    // Navigation destroys the page's execution context and leaves evaluate
    // pending forever; the timeout lets waitFor-style callers retry instead.
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out (page likely navigating)`));
    }, 5000);
    pending.set(id, (result) => {
      clearTimeout(timer);
      resolve(result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`page error: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  };
  return { ws, evaluate };
};

// ---- App UI helpers (React-controlled inputs need the native setter) ------

const setInput = `((el, v) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
})`;

const app = {};

// Wait until an expression evaluates truthy in the page; navigation and React
// re-renders (especially after connect/disconnect) make one-shot queries racy.
const waitFor = async (expression, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await app.evaluate(`(async () => { ${gwDecl} return (${expression}); })()`);
      if (value) return value;
    } catch { /* page may be mid-navigation */ }
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${expression}`);
    await sleep(600);
  }
};

const readStatus = async () => waitFor(`(() => {
  const text = document.body.innerText;
  const status = text.match(/Connection Status\\s*\\n\\s*(\\S+)/);
  return status ? { status: status[1], text: text.slice(0, 800) } : null;
})()`);

const openServerSettings = async () => {
  await app.evaluate(`location.href = "/settings/server"; "nav"`).catch(() => {});
  await waitFor(`!!document.querySelector('input[type=url]')`);
};

const clickConnect = async () => waitFor(`(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().toLowerCase() === 'connect');
  if (!button) return null;
  button.click();
  return 'clicked';
})()`);

const clickDisconnect = async () => waitFor(`(() => {
  const button = [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().toLowerCase() === 'disconnect');
  if (!button) return null;
  button.click();
  return 'clicked';
})()`, 5000).catch(() => 'no-disconnect');

const connectWith = async (url, token) => {
  await openServerSettings();
  if ((await clickDisconnect()) === 'clicked') {
    await waitFor(`[...document.querySelectorAll('button')]
      .some((b) => b.textContent.trim().toLowerCase() === 'connect')`);
  }
  await app.evaluate(`(${setInput})(document.querySelector('input[type=url]'), ${JSON.stringify(url)}); "url"`);
  await app.evaluate(`(${setInput})(document.querySelector('input[type=password]'), ${JSON.stringify(token)}); "token"`);
  return clickConnect();
};

// ---- Gateway admin helpers -------------------------------------------------

const admin = async (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: { Authorization: `Bearer ${gatewayToken}`, ...(options.headers || {}) },
});

const activeDevices = async () => {
  const response = await admin('/api/gateway/devices');
  assert(response.ok, `admin devices list returned ${response.status}`);
  const body = await response.json();
  assert(Array.isArray(body.devices), `invalid device list: ${JSON.stringify(body)}`);
  return body.devices.filter((device) => !device.revokedAt);
};

const rememberNewTestDevice = async () => {
  const candidates = (await activeDevices()).filter(
    (device) => !baselineActiveDeviceIds.has(device.id) && !testDeviceIds.has(device.id),
  );
  assert(candidates.length === 1, `expected one new emulator device, got ${candidates.length}`);
  assert(candidates[0].name === 'Comfy Mobile Android', `unexpected device name ${candidates[0].name}`);
  activeTestDeviceId = candidates[0].id;
  testDeviceIds.add(activeTestDeviceId);
  return activeTestDeviceId;
};

const revokeDevice = async (deviceId) => {
  const response = await admin(`/api/gateway/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
  assert(response.ok, `revoke ${deviceId} returned ${response.status}`);
};

const connectExecutionSocket = async (clientId) => {
  const websocketUrl = new URL(gatewayUrl);
  websocketUrl.protocol = websocketUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  websocketUrl.pathname = '/ws';
  websocketUrl.search = `?clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(websocketUrl, {
    headers: { Authorization: `Bearer ${gatewayToken}` },
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out opening fixture WebSocket')), 10_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return socket;
};

const waitForPrompt = (socket, promptId) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timed out waiting for prompt ${promptId}`)), 45_000);
  const finish = (callback, value) => {
    clearTimeout(timer);
    socket.off('message', onMessage);
    callback(value);
  };
  const onMessage = (raw, binary) => {
    if (binary) return;
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.data?.prompt_id !== promptId) return;
    if (message.type === 'execution_error' || message.type === 'execution_interrupted') {
      finish(reject, new Error(`fixture prompt failed: ${JSON.stringify(message.data)}`));
    } else if (
      message.type === 'execution_success'
      || (message.type === 'executing' && message.data?.node === null)
    ) {
      finish(resolve, message);
    }
  };
  socket.on('message', onMessage);
});

const executeFixture = async (prompt, outputNodeId) => {
  const clientId = randomUUID();
  const promptId = randomUUID();
  const socket = await connectExecutionSocket(clientId);
  try {
    const completion = waitForPrompt(socket, promptId);
    const response = await admin('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId, prompt_id: promptId }),
    });
    const submission = await response.json();
    assert(response.ok, `fixture submission ${response.status}: ${JSON.stringify(submission)}`);
    assert(submission.prompt_id === promptId, `unexpected prompt id ${submission.prompt_id}`);
    await completion;

    const historyResponse = await admin(`/history/${promptId}`);
    const history = await historyResponse.json();
    assert(historyResponse.ok, `fixture history returned ${historyResponse.status}`);
    const output = history[promptId]?.outputs?.[outputNodeId]?.images?.[0];
    assert(output?.filename, `fixture output missing: ${JSON.stringify(history[promptId]?.outputs)}`);
    return output;
  } finally {
    socket.close();
  }
};

const clickFileTile = async (filename) => waitFor(`(() => {
  const tile = [...document.querySelectorAll('[data-e2e-file-name]')]
    .find((element) => element.dataset.e2eFileName === ${JSON.stringify(filename)});
  if (!tile) return null;
  tile.click();
  return 'clicked';
})()`, 20_000);

const closePreview = async () => waitFor(`(() => {
  const modal = document.querySelector('[data-file-preview-modal]');
  if (!modal) return 'closed';
  const close = [...modal.querySelectorAll('button')].find((button) =>
    button.title.toLowerCase().includes('close'));
  if (!close) return null;
  close.click();
  return 'clicked';
})()`, 5_000);

// ---- Suite -----------------------------------------------------------------

console.log(`Android app E2E against ${gatewayUrl}\n`);

await test('emulator is connected and app is installed', async () => {
  assert(serial.startsWith('emulator-'), `refusing non-emulator ADB serial: ${serial}`);
  const { stdout: qemu } = await adb('shell', 'getprop', 'ro.kernel.qemu');
  assert(qemu.trim() === '1', `${serial} is not an Android emulator`);
  const { stdout } = await adb('shell', 'pm', 'list', 'packages', pkg);
  assert(stdout.includes(pkg), `${pkg} not installed`);
});

await test('app cold start exposes a debuggable tauri.localhost WebView', async () => {
  await adb('shell', 'am', 'force-stop', pkg);
  await adb('shell', 'pm', 'clear', pkg);
  await adb('logcat', '-c');
  await adb('shell', 'am', 'start', '-n', activity);
  await sleep(8000);
  const conn = await connect();
  app.evaluate = conn.evaluate;
  app.close = () => conn.ws.close();
  const origin = await app.evaluate('location.origin');
  assert(origin === 'http://tauri.localhost', `unexpected origin ${origin}`);
});

await test('unauthenticated proxy access is rejected by the Gateway', async () => {
  await app.evaluate(`(async () => { ${gwDecl}
    await fetch(gw + '/api/gateway/logout', {method:'POST', credentials:'include'}).catch(() => {});
    return 'logged-out';
  })()`);
  const status = await app.evaluate(`(async () => { ${gwDecl}
    return fetch(gw + '/system_stats', {credentials:'include'}).then(r => r.status);
  })()`);
  assert(status === 401, `expected 401 without credentials, got ${status}`);
});

await test('records existing Gateway devices without modifying them', async () => {
  for (const device of await activeDevices()) baselineActiveDeviceIds.add(device.id);
});

await test('connection with a wrong token fails visibly', async () => {
  assert((await connectWith(gatewayUrl, 'definitely-not-the-token')) === 'clicked', 'connect click failed');
  await sleep(5000);
  const { status, text } = await readStatus();
  assert(status !== 'Connected', `status should not be Connected, got ${status}`);
  assert(/fail|error|invalid/i.test(text), 'no failure feedback shown to the user');
});

const waitForStatus = async (expected, timeoutMs = 20000) => {
  await waitFor(`(async () => {
    const text = document.body.innerText;
    const match = text.match(/Connection Status\\s*\\n\\s*(\\S+)/);
    return match && match[1] === ${JSON.stringify(expected)};
  })()`, timeoutMs);
};

await test('connection with the real token enrolls and shows Connected', async () => {
  assert((await connectWith(gatewayUrl, gatewayToken)) === 'clicked', 'connect click failed');
  await waitForStatus('Connected');
  await rememberNewTestDevice();
});

await test('Gateway setup and device tokens never enter WebView storage', async () => {
  const leaks = await app.evaluate(`(() => {
    const values = [localStorage, sessionStorage].flatMap((storage) =>
      Object.keys(storage).map((key) => key + '=' + storage.getItem(key)));
    return values.filter((value) =>
      value.includes(${JSON.stringify(gatewayToken)}) || value.includes('cmdt_'));
  })()`);
  const passwordValue = await app.evaluate(`document.querySelector('input[type=password]')?.value || ''`);
  assert(leaks.length === 0, `credential leaked into WebView storage keys: ${JSON.stringify(leaks)}`);
  assert(passwordValue === '', 'setup token remains visible in the password input');
});

await test('Gateway reports exactly the test-owned Android enrollment', async () => {
  const devices = await activeDevices();
  assert(devices.some((device) => device.id === activeTestDeviceId), 'test device is absent');
});

await test('revoking only the test device invalidates native reconnect', async () => {
  assert(activeTestDeviceId, 'test device id is unknown');
  await revokeDevice(activeTestDeviceId);
  await openServerSettings();
  await clickDisconnect();
  assert((await connectWith(gatewayUrl, '')) === 'clicked', 'empty-token reconnect click failed');
  await sleep(3000);
  const { status, text } = await readStatus();
  assert(status !== 'Connected', `revoked device still shows ${status}`);
  assert(/token|required|auth|fail|error/i.test(text), 'revocation failure is not visible');
});

await test('re-enrollment after revocation succeeds', async () => {
  assert((await connectWith(gatewayUrl, gatewayToken)) === 'clicked', 're-enroll click failed');
  await waitForStatus('Connected');
  await rememberNewTestDevice();
});

await test('force-stop and cold start reconnects without re-entering the token', async () => {
  await adb('shell', 'am', 'force-stop', pkg);
  await adb('shell', 'am', 'start', '-n', activity);
  await sleep(10000);
  const conn = await connect();
  app.evaluate = conn.evaluate;
  await openServerSettings();
  await waitForStatus('Connected', 25000);
});

await test('Android native WebSocket is connected after credential restore', async () => {
  await waitFor(`document.querySelector('[data-e2e-status=websocket]')?.dataset.state === 'success'`, 15_000);
});

await test('imports a server workflow and executes it from the Android UI', async () => {
  const workflowName = 'ComfyMobileAndroidE2E';
  const workflowBytes = await readFile(
    new URL('../samples/workflows/live-e2e-workflow.json', import.meta.url),
  );
  const upload = new FormData();
  upload.append('file', new Blob([workflowBytes], { type: 'application/json' }), `${workflowName}.json`);
  upload.append('filename', `${workflowName}.json`);
  upload.append('overwrite', 'true');
  const uploadResponse = await admin('/comfymobile/api/workflows/upload', {
    method: 'POST',
    body: upload,
  });
  const uploadBody = await uploadResponse.json();
  assert(uploadResponse.ok && uploadBody.status === 'success',
    `workflow upload ${uploadResponse.status}: ${JSON.stringify(uploadBody)}`);

  await app.evaluate('location.href = "/import/server"; "nav"').catch(() => {});
  await waitFor(`!!document.querySelector('input[type=text]')`, 20_000);
  await app.evaluate(`(${setInput})(document.querySelector('input[type=text]'), ${JSON.stringify(workflowName)}); "search"`);
  const imported = await waitFor(`(() => {
    const card = [...document.querySelectorAll('[data-e2e-server-workflow]')]
      .find((element) => element.dataset.e2eServerWorkflow === ${JSON.stringify(workflowName)});
    const button = card?.querySelector('[data-e2e-action=import]');
    if (!button) return null;
    button.click();
    return 'clicked';
  })()`, 20_000);
  assert(imported === 'clicked', 'server workflow import button was not clicked');

  await sleep(3000);
  await app.evaluate('location.href = "/"; "nav"').catch(() => {});
  await waitFor(`(() => {
    const tile = [...document.querySelectorAll('[data-e2e-workflow-name]')]
      .find((element) => element.dataset.e2eWorkflowName === ${JSON.stringify(workflowName)});
    if (!tile) return null;
    tile.click();
    return 'opened';
  })()`, 20_000);
  await waitFor(`!!document.querySelector('[data-e2e-action=execute]')`, 30_000);

  const beforeResponse = await admin('/history?max_items=50');
  assert(beforeResponse.ok, `history baseline returned ${beforeResponse.status}`);
  const beforeIds = new Set(Object.keys(await beforeResponse.json()));
  const executeClicked = await app.evaluate(`(() => {
    const button = document.querySelector('[data-e2e-action=execute]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(executeClicked, 'Android execute button was not clicked');

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !appExecutionOutput) {
    const historyResponse = await admin('/history?max_items=50');
    if (historyResponse.ok) {
      const history = await historyResponse.json();
      for (const [promptId, run] of Object.entries(history)) {
        if (beforeIds.has(promptId)) continue;
        const output = run?.outputs?.['2']?.images?.[0];
        if (output?.filename?.startsWith('UI_')) {
          appExecutionOutput = output;
          break;
        }
      }
    }
    if (!appExecutionOutput) await sleep(1000);
  }
  assert(appExecutionOutput?.filename, 'Android-submitted workflow produced no output');
  const outputParams = new URLSearchParams({
    filename: appExecutionOutput.filename,
    subfolder: appExecutionOutput.subfolder || '',
    type: appExecutionOutput.type || 'output',
  });
  const outputResponse = await admin(`/view?${outputParams}`);
  assert(outputResponse.ok, `Android workflow output returned ${outputResponse.status}`);
  assert((outputResponse.headers.get('content-type') || '').startsWith('image/'),
    `unexpected Android workflow output type ${outputResponse.headers.get('content-type')}`);
});

await test('creates deterministic image and MP4 fixtures through the public Gateway', async () => {
  const runId = randomUUID();
  imageOutput = await executeFixture({
    1: { class_type: 'LoadImage', inputs: { image: inputImage } },
    2: {
      class_type: 'SaveImage',
      inputs: { images: ['1', 0], filename_prefix: `ComfyMobileE2E/Android/${runId}` },
    },
  }, '2');

  videoOutput = await executeFixture({
    1: { class_type: 'EmptyImage', inputs: { width: 160, height: 120, batch_size: 2, color: 0xff0000 } },
    2: { class_type: 'EmptyImage', inputs: { width: 160, height: 120, batch_size: 2, color: 0x00ff00 } },
    3: { class_type: 'ImageBatch', inputs: { image1: ['1', 0], image2: ['2', 0] } },
    4: { class_type: 'CreateVideo', inputs: { images: ['3', 0], fps: 2 } },
    5: {
      class_type: 'SaveVideo',
      inputs: { video: ['4', 0], filename_prefix: `ComfyMobileE2E/Android/Video/${runId}`, format: 'mp4' },
    },
  }, '5');
  assert(/\.png$/i.test(imageOutput.filename), `unexpected image ${imageOutput.filename}`);
  assert(/\.mp4$/i.test(videoOutput.filename), `unexpected video ${videoOutput.filename}`);
});

await test('Android gallery loads and renders authenticated image bytes', async () => {
  assert(imageOutput, 'image fixture missing');
  await app.evaluate('location.href = "/outputs"; "nav"').catch(() => {});
  await clickFileTile(imageOutput.filename);
  const dimensions = await waitFor(`(() => {
    const image = document.querySelector('[data-file-preview-modal] img[alt=${JSON.stringify(imageOutput.filename)}]');
    return image && image.complete && image.naturalWidth > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null;
  })()`, 25_000);
  assert(dimensions.width > 0 && dimensions.height > 0, 'image did not decode');
  await closePreview();
});

await test('Android gallery loads and decodes authenticated MP4 metadata', async () => {
  assert(videoOutput, 'video fixture missing');
  await waitFor(`(() => {
    const toggle = document.querySelector('button svg.lucide-video')?.closest('button');
    if (!toggle) return null;
    toggle.click();
    return 'clicked';
  })()`);
  await clickFileTile(videoOutput.filename);
  const metadata = await waitFor(`(() => {
    const video = document.querySelector('[data-file-preview-modal] video');
    return video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0
      ? { duration: video.duration, error: video.error && video.error.code }
      : null;
  })()`, 30_000);
  assert(!metadata.error, `video element error ${metadata.error}`);
  assert(metadata.duration > 0, `invalid duration ${metadata.duration}`);
});

await test('Android DownloadManager saves the authenticated MP4 completely', async () => {
  assert(videoOutput, 'video fixture missing');
  const filename = videoOutput.filename.split('/').pop();
  const remoteParams = new URLSearchParams({
    filename: videoOutput.filename,
    subfolder: videoOutput.subfolder || '',
    type: videoOutput.type || 'output',
  });
  const remote = await admin(`/view?${remoteParams}`);
  assert(remote.ok, `remote video returned ${remote.status}`);
  const expectedSize = (await remote.arrayBuffer()).byteLength;
  const downloadPath = `/sdcard/Download/${filename}`;
  await adb('shell', 'rm', '-f', downloadPath);
  const clicked = await app.evaluate(`(() => {
    const button = document.querySelector('[data-file-preview-modal] [data-e2e-action=download]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, 'download button not found');

  const deadline = Date.now() + 30_000;
  let downloadedSize = 0;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await adb('shell', 'stat', '-c', '%s', downloadPath);
      downloadedSize = Number(stdout.trim());
      if (downloadedSize === expectedSize) break;
    } catch { /* DownloadManager has not created the file yet */ }
    await sleep(1000);
  }
  assert(downloadedSize === expectedSize, `download size ${downloadedSize}, expected ${expectedSize}`);
  await adb('shell', 'rm', '-f', downloadPath);
});

await test('authenticated API works from the app WebView (cookie + CSRF path)', async () => {
  const codes = await app.evaluate(`(async () => { ${gwDecl}
    const login = await fetch(gw + '/api/gateway/login', {method:'POST', credentials:'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({token: ${JSON.stringify(gatewayToken)}, remember: true})});
    return {
      login: login.status,
      stats: await fetch(gw + '/system_stats', {credentials:'include'}).then(r => r.status),
      queue: await fetch(gw + '/queue', {credentials:'include'}).then(r => r.status),
    };
  })()`);
  assert(codes.login === 200, `login ${codes.login}`);
  assert(codes.stats === 200, `system_stats ${codes.stats}`);
  assert(codes.queue === 200, `queue ${codes.queue}`);
});

await test('authenticated WebSocket opens from the WebView (third-party cookie path)', async () => {
  const outcome = await app.evaluate(`(async () => {
    const url = ${JSON.stringify(gatewayUrl)}.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws?clientId=e2e-android';
    return await new Promise((resolve) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); resolve('timeout'); }, 8000);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('open'); };
      socket.onerror = () => { clearTimeout(timer); resolve('error'); };
      socket.onclose = (event) => { clearTimeout(timer); resolve('closed:' + event.code); };
    });
  })()`);
  assert(outcome === 'open' || outcome === 'closed:1000', `WebSocket outcome: ${outcome}`);
});

if (process.env.E2E_AGENT_LIVE === '1') {
  await test('real agent repairs, previews, saves and reopens a workflow on Android', async () => {
    const { agentAndroidScenario } = await import('./agent-android-scenario.mjs');
    try {
      await agentAndroidScenario({ app, waitFor, assert, admin, adb, connect, pkg, activity, sleep, videoOutput });
    } catch (error) {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const directory = new URL('../output/agent-android/', import.meta.url);
      await mkdir(directory, {recursive:true});
      await writeFile(new URL('failure.txt', directory), await app.evaluate('document.body.innerText').catch(() => 'WebView unavailable'));
      const {stdout} = await exec('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], {encoding:'buffer'});
      await writeFile(new URL('failure.png', directory), stdout);
      throw error;
    }
  });
}

if (process.env.E2E_AGENT_MODELS === '1') {
  await test('Z-Image and H3 model workflows generate and render through Android agent UI', async () => {
    const { agentModelsAndroidScenario } = await import('./agent-models-android-scenario.mjs');
    try { await agentModelsAndroidScenario({ app, waitFor, assert, adb, sleep }); }
    catch(error) {
      const {mkdir,writeFile}=await import('node:fs/promises');
      const directory=new URL('../output/agent-models-android/',import.meta.url);await mkdir(directory,{recursive:true});
      await writeFile(new URL('failure.txt',directory),await app.evaluate('document.body.innerText').catch(()=> 'WebView unavailable'));
      throw error;
    }
  });
}

if (process.env.E2E_AGENT_TRANSCRIPT === '1') {
  await test('transcript renders a follow-up table and copies code through Android clipboard', async () => {
    assert.equal(process.env.E2E_AGENT_MODELS, '1', 'Transcript scenario requires E2E_AGENT_MODELS=1');
    const { transcriptAndroidScenario } = await import('./transcript-android-scenario.mjs');
    await transcriptAndroidScenario({ app, waitFor, assert, adb, sleep });
  });
}

if (process.env.E2E_AGENT_I18N === '1') {
  await test('assistant history is accessible and localized in all four languages', async () => {
    const { agentI18nAndroidScenario } = await import('./agent-i18n-android-scenario.mjs');
    await agentI18nAndroidScenario({ app, waitFor, assert, sleep });
  });
}

app.close?.();

await test('cleans up only emulator-created Gateway credentials', async () => {
  for (const deviceId of testDeviceIds) {
    const device = (await activeDevices()).find((candidate) => candidate.id === deviceId);
    if (device) await revokeDevice(deviceId);
  }
  for (const device of await activeDevices()) {
    assert(!testDeviceIds.has(device.id), `test device ${device.id} is still active`);
  }
  await adb('shell', 'am', 'force-stop', pkg);
  await adb('shell', 'pm', 'clear', pkg);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log('\nFailed:');
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed.length ? 1 : 0);
