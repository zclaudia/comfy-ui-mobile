// Enroll the Android emulator, import the deterministic manual workflows, and
// smoke-test each one through the real app UI. The app is intentionally left
// connected on its workflow list for interactive testing.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const exec = promisify(execFile);
const serial = process.env.EMULATOR_SERIAL || 'emulator-5554';
const pkg = 'app.comfymobile.client.debug';
const activity = `${pkg}/app.comfymobile.client.MainActivity`;
const gatewayUrl = (process.env.E2E_GATEWAY_URL || 'https://comfy.zhvala.space:28443').replace(/\/$/, '');
const gatewayToken = process.env.E2E_GATEWAY_TOKEN?.trim();

if (!gatewayToken) throw new Error('E2E_GATEWAY_TOKEN is required');
assert.match(serial, /^emulator-/, `Refusing non-emulator ADB target: ${serial}`);

const workflows = [
  {
    serverName: 'ManualTest_01_Image_Load_Save',
    localName: 'ManualTest 01 Image Load Save',
    outputPrefix: 'ManualTest/Image_Load_Save',
    type: 'image/',
    execute: true,
  },
  {
    serverName: 'ManualTest_02_Image_Color_Batch',
    localName: 'ManualTest 02 Image Color Batch',
    outputPrefix: 'ManualTest/Image_Color_Batch',
    type: 'image/',
    execute: true,
  },
  {
    serverName: 'ManualTest_03_Video_MP4_Color',
    localName: 'ManualTest 03 Video MP4 Color',
    outputPrefix: 'ManualTest/Video_MP4_Color',
    type: 'video/mp4',
    execute: true,
  },
  {
    serverName: 'ManualTest_04_Video_WEBM_Color',
    localName: 'ManualTest 04 Video WEBM Color',
    outputPrefix: 'ManualTest/Video_WEBM_Color',
    type: 'video/webm',
    execute: true,
  },
  {
    serverName: '图片_Z-Image_标准1024',
    localName: '图片 Z Image 标准1024',
    execute: false,
  },
  {
    serverName: 'H3_文生视频_FL2VA_省显存LoRA_8步',
    localName: 'H3 文生视频 FL2VA 省显存LoRA 8步',
    execute: false,
  },
];

const adb = (...args) => exec('adb', ['-s', serial, ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: { Authorization: `Bearer ${gatewayToken}`, ...(options.headers || {}) },
});

const connectDevTools = async () => {
  let pid = '';
  for (let attempt = 0; attempt < 20 && !pid; attempt += 1) {
    pid = (await adb('shell', 'pidof', pkg).catch(() => ({ stdout: '' }))).stdout.trim().split(/\s+/)[0];
    if (!pid) await sleep(500);
  }
  assert.ok(pid, 'App process did not start');
  await adb('forward', 'tcp:9223', `localabstract:webview_devtools_remote_${pid}`);

  let page;
  for (let attempt = 0; attempt < 20 && !page; attempt += 1) {
    const pages = await fetch('http://127.0.0.1:9223/json').then((response) => response.json());
    page = pages.find((candidate) => candidate.type === 'page' && candidate.url.startsWith('http://tauri.localhost'));
    if (!page) await sleep(500);
  }
  assert.ok(page, 'No debuggable tauri.localhost WebView found');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let sequence = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (!message.id || !pending.has(message.id)) return;
    pending.get(message.id)(message.result);
    pending.delete(message.id);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP ${method} timed out`));
    }, 5_000);
    pending.set(id, (result) => {
      clearTimeout(timeout);
      resolve(result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || 'Page evaluation failed');
    return result.result.value;
  };
  return { socket, evaluate };
};

const setInput = `((element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
})`;

await adb('shell', 'am', 'force-stop', pkg);
await adb('shell', 'am', 'start', '-n', activity);
await sleep(5_000);

const app = await connectDevTools();
const waitFor = async (expression, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await app.evaluate(`(async () => (${expression}))()`);
      if (value) return value;
    } catch { /* navigation briefly destroys the execution context */ }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${expression}`);
};

const navigate = async (path) => {
  await app.evaluate(`location.href = ${JSON.stringify(path)}; 'navigating'`).catch(() => {});
};

const workflowNamesInDb = () => app.evaluate(`new Promise((resolve, reject) => {
  const open = indexedDB.open('ComfyMobileUI', 3);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const getAll = open.result.transaction('workflows', 'readonly').objectStore('workflows').getAll();
    getAll.onerror = () => reject(getAll.error);
    getAll.onsuccess = () => resolve(getAll.result.map((workflow) => workflow.name));
  };
})`);

console.log(`Preparing ${serial} against ${gatewayUrl}`);
const qemu = (await adb('shell', 'getprop', 'ro.kernel.qemu')).stdout.trim();
assert.equal(qemu, '1', `${serial} is not an Android virtual device`);

await navigate('/settings/server');
await waitFor(`!!document.querySelector('input[type=url]')`);
const connectionAction = await waitFor(`(() => {
  const labels = [...document.querySelectorAll('button')].map((button) => button.textContent.trim().toLowerCase());
  if (labels.includes('disconnect')) return 'disconnect';
  if (labels.includes('connect')) return 'connect';
  return null;
})()`, 20_000);
if (connectionAction === 'connect') {
  await app.evaluate(`(${setInput})(document.querySelector('input[type=url]'), ${JSON.stringify(gatewayUrl)}); 'url-set'`);
  await app.evaluate(`(${setInput})(document.querySelector('input[type=password]'), ${JSON.stringify(gatewayToken)}); 'token-set'`);
  const clicked = await app.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().toLowerCase() === 'connect');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(clicked, 'Connect button was not available');
  await waitFor(`[...document.querySelectorAll('button')]
    .some((button) => button.textContent.trim().toLowerCase() === 'disconnect')`, 30_000);
}
// Never leave the one-time setup token visible in the WebView after enrollment.
await app.evaluate(`(() => {
  const input = document.querySelector('input[type=password]');
  if (input && input.value) (${setInput})(input, '');
  return true;
})()`);
console.log('  ✓ Gateway connected');

const existing = new Set(await workflowNamesInDb());
const missing = workflows.filter((workflow) => !existing.has(workflow.localName));
if (missing.length) {
  await navigate('/import/server');
  await waitFor(`!!document.querySelector('input[type=text]')`, 30_000);

  for (const workflow of missing) {
    await app.evaluate(`(${setInput})(document.querySelector('input[type=text]'), ${JSON.stringify(workflow.serverName)}); 'search-set'`);
    await waitFor(`[...document.querySelectorAll('[data-e2e-server-workflow]')]
      .some((element) => element.dataset.e2eServerWorkflow === ${JSON.stringify(workflow.serverName)})`, 20_000);
    const clicked = await app.evaluate(`(() => {
      const card = [...document.querySelectorAll('[data-e2e-server-workflow]')]
        .find((element) => element.dataset.e2eServerWorkflow === ${JSON.stringify(workflow.serverName)});
      const button = card?.querySelector('[data-e2e-action=import]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert.ok(clicked, `Could not click Import for ${workflow.serverName}`);
    await waitFor(`new Promise((resolve) => {
      const open = indexedDB.open('ComfyMobileUI', 3);
      open.onsuccess = () => {
        const getAll = open.result.transaction('workflows', 'readonly').objectStore('workflows').getAll();
        getAll.onsuccess = () => resolve(getAll.result.some((item) => item.name === ${JSON.stringify(workflow.localName)}));
      };
    })`, 20_000);
    console.log(`  ✓ Imported ${workflow.localName}`);
  }
}

const allNames = new Set(await workflowNamesInDb());
for (const workflow of workflows) {
  assert.ok(allNames.has(workflow.localName), `${workflow.localName} is missing from IndexedDB`);
}

const collectFiles = (value, files = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectFiles(item, files);
  } else if (value && typeof value === 'object') {
    if (typeof value.filename === 'string') files.push(value);
    else for (const item of Object.values(value)) collectFiles(item, files);
  }
  return files;
};

for (const workflow of workflows.filter((candidate) => candidate.execute)) {
  const baselineResponse = await admin('/history?max_items=100');
  assert.ok(baselineResponse.ok, `History baseline failed with ${baselineResponse.status}`);
  const baselineIds = new Set(Object.keys(await baselineResponse.json()));

  await navigate('/');
  await waitFor(`(() => {
    const tile = [...document.querySelectorAll('[data-e2e-workflow-name]')]
      .find((element) => element.dataset.e2eWorkflowName === ${JSON.stringify(workflow.localName)});
    if (!tile) return false;
    tile.click();
    return true;
  })()`, 20_000);
  await waitFor(`!!document.querySelector('[data-e2e-action=execute]')`, 30_000);
  const executed = await app.evaluate(`(() => {
    const button = document.querySelector('[data-e2e-action=execute]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.ok(executed, `Execute button missing for ${workflow.localName}`);

  let output;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !output) {
    const response = await admin('/history?max_items=100');
    if (response.ok) {
      const history = await response.json();
      for (const [promptId, run] of Object.entries(history)) {
        if (baselineIds.has(promptId)) continue;
        output = collectFiles(run?.outputs).find((file) => {
          const path = [file.subfolder, file.filename].filter(Boolean).join('/');
          return path.startsWith(workflow.outputPrefix);
        });
        if (output) break;
        const messages = run?.status?.messages || [];
        const failed = messages.find(([type]) => type === 'execution_error');
        if (failed) throw new Error(`${workflow.localName} failed: ${JSON.stringify(failed[1])}`);
      }
    }
    if (!output) await sleep(750);
  }
  assert.ok(output, `${workflow.localName} produced no matching output`);

  const params = new URLSearchParams({
    filename: output.filename,
    subfolder: output.subfolder || '',
    type: output.type || 'output',
  });
  const media = await admin(`/view?${params}`);
  assert.ok(media.ok, `${workflow.localName} output could not be loaded`);
  assert.ok((media.headers.get('content-type') || '').startsWith(workflow.type),
    `${workflow.localName} returned ${media.headers.get('content-type')}`);
  console.log(`  ✓ Executed ${workflow.localName}`);
}

await navigate('/');
await waitFor(`document.querySelectorAll('[data-e2e-workflow-name]').length >= ${workflows.length}`);
console.log(`\nReady: ${workflows.length} manual workflows are visible in the emulator.`);
app.socket.close();
