// Verifies cloud-first workflow behavior through the real Android WebView.
// It deliberately refuses physical ADB targets. Existing Gateway enrollment
// and connection settings are preserved while only the workflow cache is reset.

import assert from 'node:assert/strict';
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
const expectedWorkflowNames = [
  'ManualTest 01 Image Load Save',
  'ManualTest 03 Video MP4 Color',
  '图片 Z Image 标准1024',
  'H3 文生视频 FL2VA 省显存LoRA 8步',
];

if (!gatewayToken) throw new Error('E2E_GATEWAY_TOKEN is required');
assert.match(serial, /^emulator-/, `Refusing non-emulator ADB target: ${serial}`);

const adb = (...args) => exec('adb', ['-s', serial, ...args]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: { Authorization: `Bearer ${gatewayToken}`, ...(options.headers || {}) },
});

const connectDevTools = async () => {
  let pid = '';
  for (let attempt = 0; attempt < 30 && !pid; attempt += 1) {
    pid = (await adb('shell', 'pidof', pkg).catch(() => ({ stdout: '' }))).stdout.trim().split(/\s+/)[0];
    if (!pid) await sleep(500);
  }
  assert.ok(pid, 'App process did not start');
  await adb('forward', 'tcp:9224', `localabstract:webview_devtools_remote_${pid}`);

  let page;
  for (let attempt = 0; attempt < 30 && !page; attempt += 1) {
    const pages = await fetch('http://127.0.0.1:9224/json').then((response) => response.json());
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
    }, 6_000);
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page evaluation failed');
    }
    return result.result.value;
  };
  return { socket, evaluate };
};

const setInput = `((element, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
})`;

const workflowQuery = (projection) => `new Promise((resolve, reject) => {
  const open = indexedDB.open('ComfyMobileUI', 3);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = open.result.transaction('workflows', 'readonly').objectStore('workflows').getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result${projection});
  };
})`;

const qemu = (await adb('shell', 'getprop', 'ro.kernel.qemu')).stdout.trim();
assert.equal(qemu, '1', `${serial} is not an Android virtual device`);
assert.match(
  (await adb('shell', 'pm', 'list', 'packages', pkg)).stdout,
  new RegExp(`package:${pkg.replaceAll('.', '\\.')}`),
  `${pkg} is not installed`,
);

await adb('shell', 'am', 'force-stop', pkg);
await adb('shell', 'am', 'start', '-n', activity);
await sleep(6_000);
const app = await connectDevTools();

const waitFor = async (expression, timeoutMs = 30_000) => {
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

const listServerWorkflows = async () => {
  const response = await admin('/comfymobile/api/workflows/list');
  const body = await response.json();
  assert.ok(response.ok, `Workflow listing returned ${response.status}: ${JSON.stringify(body)}`);
  return body.workflows;
};

console.log(`Cloud workflow Android E2E on ${serial}`);

// Preserve a valid existing native device credential when present, but make
// this test reproducible on a fresh debug install by enrolling when needed.
await navigate('/settings/server');
await waitFor(`!!document.querySelector('input[type=url]')`);
let connectionAction = await waitFor(`(() => {
  const labels = [...document.querySelectorAll('button')].map((button) => button.textContent.trim().toLowerCase());
  if (labels.includes('disconnect')) return 'disconnect';
  if (labels.includes('connect')) return 'connect';
  return null;
})()`);
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
  connectionAction = await waitFor(`[...document.querySelectorAll('button')]
    .some((button) => button.textContent.trim().toLowerCase() === 'disconnect') && 'disconnect'`, 35_000);
}
assert.equal(connectionAction, 'disconnect');
await app.evaluate(`(() => {
  const input = document.querySelector('input[type=password]');
  if (input && input.value) (${setInput})(input, '');
  return true;
})()`);
console.log('  ✓ Connected with native Gateway credentials');

await navigate('/');
await waitFor(`document.querySelector('[data-e2e-cloud-sync]')?.dataset.state === 'synced'`, 40_000);

// This is the decisive regression check: no Import route is visited. With an
// empty local object store the App must repopulate directly from ComfyUI.
await app.evaluate(`new Promise((resolve, reject) => {
  const open = indexedDB.open('ComfyMobileUI', 3);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const request = open.result.transaction('workflows', 'readwrite').objectStore('workflows').clear();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      window.dispatchEvent(new CustomEvent('comfy-workflow-local-change'));
      resolve(true);
    };
  };
})`);

await waitFor(`${workflowQuery('.map((workflow) => workflow.name)')}.then((names) =>
  ${JSON.stringify(expectedWorkflowNames)}.every((name) => names.includes(name)))`, 45_000);
await waitFor(`document.querySelector('[data-e2e-cloud-sync]')?.dataset.state === 'synced'`, 20_000);
for (const name of expectedWorkflowNames) {
  await waitFor(`[...document.querySelectorAll('[data-e2e-workflow-name]')]
    .some((tile) => tile.dataset.e2eWorkflowName === ${JSON.stringify(name)})`);
}
const cachedCount = await app.evaluate(`${workflowQuery('.length')}`);
console.log(`  ✓ Empty IndexedDB automatically repopulated with ${cachedCount} cloud workflows`);

// Exercise the reverse direction using the real upload UI and local-change
// event. The controller must create the server file and attach cloud metadata.
const testName = `CloudSyncAndroidE2E_${randomUUID()}`;
const fixture = JSON.parse(await readFile(
  new URL('../samples/workflows/live-e2e-workflow.json', import.meta.url),
  'utf8',
));
fixture.extra = { ...(fixture.extra || {}), name: testName, description: 'Temporary Android cloud sync E2E' };

const addClicked = await app.evaluate(`(() => {
  const button = document.querySelector('[data-e2e-action=add-workflow]');
  if (!button) return false;
  button.click();
  return true;
})()`);
assert.ok(addClicked, 'Add workflow button was not found');
await waitFor(`!!document.querySelector('[data-e2e-workflow-file]')`);
await app.evaluate(`(() => {
  const input = document.querySelector('[data-e2e-workflow-file]');
  const transfer = new DataTransfer();
  transfer.items.add(new File(
    [${JSON.stringify(JSON.stringify(fixture))}],
    ${JSON.stringify(`${testName}.json`)},
    { type: 'application/json' }
  ));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

await waitFor(`${workflowQuery(`.some((workflow) => workflow.name === ${JSON.stringify(testName)}
  && workflow.cloud?.dirty === false && !!workflow.cloud?.etag)`)}`, 45_000);

let created;
for (let attempt = 0; attempt < 30 && !created; attempt += 1) {
  created = (await listServerWorkflows()).find((workflow) => workflow.filename === `${testName}.json`);
  if (!created) await sleep(500);
}
assert.ok(created?.etag, 'Android-created workflow did not reach the cloud');
console.log('  ✓ UI import automatically uploaded to ComfyUI');

// Delete the temporary server file and prove remote deletion removes a clean
// cache entry. The manual cloud workflows remain ready for user testing.
const deletion = await admin(`/comfymobile/api/workflows/content/${encodeURIComponent(`${testName}.json`)}`, {
  method: 'DELETE',
  headers: { 'If-Match': created.etag },
});
assert.ok(deletion.ok, `Temporary workflow cleanup returned ${deletion.status}: ${await deletion.text()}`);
await app.evaluate(`window.dispatchEvent(new CustomEvent('comfy-workflow-local-change')); true`);
await waitFor(`${workflowQuery(`.every((workflow) => workflow.name !== ${JSON.stringify(testName)})`)}`, 35_000);
await waitFor(`document.querySelector('[data-e2e-cloud-sync]')?.dataset.state === 'synced'`, 20_000);
console.log('  ✓ Cloud deletion removed the clean offline cache entry');

await navigate('/');
await waitFor(`document.querySelectorAll('[data-e2e-workflow-name]').length >= ${expectedWorkflowNames.length}`);
console.log('  ✓ Emulator left on the automatically synchronized workflow list');
app.socket.close();
