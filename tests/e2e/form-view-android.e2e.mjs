// End-to-end test for the mobile form view, driven through the real Android
// WebView in an emulator.
//
// It proves the whole feature on the device rather than in a browser: the form
// is what opening a workflow lands on, its inputs edit the same graph the
// canvas does, linked inputs write every target, pinning from the node panel
// changes the form, the spec survives an app restart and reaches the server,
// and a run submitted from the form produces a real image.
//
// Prerequisites:
//   - A booted AVD in `adb devices` (EMULATOR_SERIAL, default emulator-5554)
//   - The debug APK installed: app.comfymobile.client.debug
//   - A reachable Gateway (E2E_GATEWAY_URL) whose setup token is E2E_GATEWAY_TOKEN
//
// Run: npm run test:e2e:form:android

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const exec = promisify(execFile);
const serial = process.env.EMULATOR_SERIAL || 'emulator-5554';
const pkg = 'app.comfymobile.client.debug';
const activity = `${pkg}/app.comfymobile.client.MainActivity`;
const gatewayUrl = (process.env.E2E_GATEWAY_URL || 'https://comfy.zhvala.space:28443').replace(/\/$/, '');
const gatewayToken = process.env.E2E_GATEWAY_TOKEN?.trim();

if (!gatewayToken) throw new Error('E2E_GATEWAY_TOKEN is required (the Gateway setup token)');
assert.match(serial, /^emulator-/, `Refusing non-emulator ADB target: ${serial}`);

const adb = (...args) => exec('adb', ['-s', serial, ...args], { maxBuffer: 32 * 1024 * 1024 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const admin = (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: { Authorization: `Bearer ${gatewayToken}`, ...(options.headers || {}) },
});

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.message || error) });
    console.log(`  ✗ ${name}\n    ${error?.message || error}`);
  }
};

// ---- WebView DevTools ------------------------------------------------------

const connectDevTools = async () => {
  let pid = '';
  for (let attempt = 0; attempt < 40 && !pid; attempt += 1) {
    pid = (await adb('shell', 'pidof', pkg).catch(() => ({ stdout: '' }))).stdout.trim().split(/\s+/)[0];
    if (!pid) await sleep(500);
  }
  assert.ok(pid, 'App process did not start');
  await adb('forward', 'tcp:9225', `localabstract:webview_devtools_remote_${pid}`);

  let page;
  for (let attempt = 0; attempt < 40 && !page; attempt += 1) {
    const pages = await fetch('http://127.0.0.1:9225/json').then((r) => r.json()).catch(() => []);
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
    }, 15_000);
    pending.set(id, (result) => { clearTimeout(timeout); resolve(result); });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await call('Runtime.enable');
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text || 'page error';
      throw new Error(detail.split('\n').slice(0, 3).join(' | '));
    }
    return result.result.value;
  };
  return { socket, evaluate };
};

let app;

const waitFor = async (expression, timeoutMs = 30_000, label = expression) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await app.evaluate(`(async () => (${expression}))()`);
      if (value) return value;
    } catch { /* navigation destroys the execution context briefly */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await sleep(600);
  }
};

const navigate = async (path) => {
  await app.evaluate(`location.href = ${JSON.stringify(path)}; 'navigating'`).catch(() => {});
};

const restartApp = async () => {
  await adb('shell', 'am', 'force-stop', pkg);
  await adb('shell', 'am', 'start', '-n', activity);
  await sleep(7_000);
  app = await connectDevTools();
  await waitFor(`document.readyState === 'complete'`, 30_000, 'app boot');
};

// ---- Gateway enrolment -----------------------------------------------------

/**
 * On Android every request goes through the Tauri HTTP plugin, which holds the
 * device credentials natively — a page-level `fetch` is unauthenticated even
 * when the app is fully enrolled. So ask the app's own connection state, and
 * confirm it by having the app reach the server.
 */
const isAuthenticated = async () => {
  const state = await app.evaluate(`(() => {
    try {
      const raw = localStorage.getItem('comfy-connection-store') || localStorage.getItem('connection-store');
      if (raw) {
        const parsed = JSON.parse(raw);
        const value = parsed.state || parsed;
        if (value && typeof value.isConnected === 'boolean') return value.isConnected;
      }
    } catch { /* fall through to the DOM probe */ }
    return null;
  })()`).catch(() => null);
  if (state === true) return true;
  // Fall back to observable behaviour: a connected app lists server workflows.
  return !!(await app.evaluate(`(async () => {
    const all = await new Promise((resolve) => {
      const open = indexedDB.open('ComfyMobileUI');
      open.onerror = () => resolve([]);
      open.onsuccess = () => {
        const request = open.result.transaction('workflows', 'readonly').objectStore('workflows').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve([]);
      };
    });
    return all.length > 0;
  })()`).catch(() => false));
};

/**
 * A freshly installed APK has no device credentials, so the suite enrols the
 * emulator the way a person would: the server settings screen.
 */
const enrolDevice = async () => {
  await navigate('/settings/server');
  await waitFor(`!!document.querySelector('input[type=url]')`, 30_000, 'the server settings form');
  await app.evaluate(`(async () => {
    const setValue = (element, value) => {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const disconnect = [...document.querySelectorAll('button')]
      .find((b) => /^(disconnect|断开|연결 해제|切断)/i.test(b.innerText.trim()));
    if (disconnect) { disconnect.click(); await new Promise((r) => setTimeout(r, 1500)); }
    setValue(document.querySelector('input[type=url]'), ${JSON.stringify(gatewayUrl)});
    const token = document.querySelector('input[type=password]');
    if (token) setValue(token, ${JSON.stringify(gatewayToken)});
    return 'filled';
  })()`);
  await sleep(600);
  await waitFor(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((b) => /^(connect|连接|接続|연결)$/i.test(b.innerText.trim()));
    if (!button || button.disabled) return null;
    button.click();
    return 'clicked';
  })()`, 20_000, 'the connect button');
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await isAuthenticated()) return;
    await sleep(1_000);
  }
  throw new Error('the device did not enrol with the Gateway');
};

// ---- Fixtures --------------------------------------------------------------

const stamp = Date.now();
const workflowName = `FormViewE2E-${stamp}`;
const filename = `${workflowName}.json`;
const outputPrefix = `ComfyMobile/FormViewE2E/${stamp}`;

const uploadFixtureWorkflow = async () => {
  const fixture = JSON.parse(await readFile(new URL('../fixtures/form-view-workflow.json', import.meta.url), 'utf8'));
  fixture.extra = { ...(fixture.extra || {}), name: workflowName };
  // A unique output prefix makes this run's images identifiable in history.
  const save = fixture.nodes.find((node) => node.type === 'SaveImage');
  save.widgets_values = [outputPrefix];
  save.widgets_values_named = { filename_prefix: outputPrefix };

  const response = await admin('/comfymobile/api/workflows/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content: fixture, overwrite: true }),
  });
  assert.ok(response.ok, `Uploading the fixture returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
};

const deleteFixtureWorkflow = async () => {
  await admin(`/comfymobile/api/workflows/content/${encodeURIComponent(filename)}`, { method: 'DELETE' }).catch(() => {});
};

/** The device's local id for the synced fixture. */
const findWorkflowId = async () => waitFor(`(async () => {
  const wanted = ${JSON.stringify(workflowName)};
  const all = await new Promise((resolve, reject) => {
    const open = indexedDB.open('ComfyMobileUI');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('workflows', 'readonly').objectStore('workflows').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
  const found = all.find((entry) => entry.name === wanted);
  return found ? found.id : null;
})()`, 90_000, 'the fixture workflow to sync down to the device');

const readStoredSpec = async (workflowId) => app.evaluate(`(async () => {
  const all = await new Promise((resolve, reject) => {
    const open = indexedDB.open('ComfyMobileUI');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = open.result.transaction('workflows', 'readonly').objectStore('workflows').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
  const found = all.find((entry) => entry.id === ${JSON.stringify(workflowId)});
  return JSON.stringify(found?.workflow_json?.extra?.comfy_mobile_form ?? null);
})()`).then((value) => JSON.parse(value));

/**
 * Edits a numeric field on the form the way a person does: tap the value, type,
 * save. Returns the field's text afterwards.
 */
const setNumericField = async (fieldKey, value) => app.evaluate(`(async () => {
  const field = () => document.querySelector('[data-form-field=' + JSON.stringify(${JSON.stringify(fieldKey)}) + ']');
  if (!field()) return 'missing';
  field().querySelector('button').click();
  await new Promise((r) => setTimeout(r, 700));
  const input = field().querySelector('input[type=number]');
  if (!input) return 'no-input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, ${JSON.stringify(String(value))});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 300));
  const save = [...field().querySelectorAll('button')].find((b) => /Save|保存|저장|保存する/.test(b.innerText));
  if (!save) return 'no-save';
  save.click();
  await new Promise((r) => setTimeout(r, 900));
  return field().innerText.replace(/\\n/g, ' | ');
})()`);

// ---- Suite -----------------------------------------------------------------

console.log(`Form view Android E2E against ${gatewayUrl}\n`);

let workflowId = null;

await test('emulator is an AVD with the debug app installed', async () => {
  const { stdout: qemu } = await adb('shell', 'getprop', 'ro.kernel.qemu');
  assert.equal(qemu.trim(), '1', `${serial} is not an Android emulator`);
  const { stdout } = await adb('shell', 'pm', 'list', 'packages', pkg);
  assert.ok(stdout.includes(pkg), `${pkg} is not installed`);
});

await test('the app boots and is enrolled with the Gateway', async () => {
  await uploadFixtureWorkflow();
  await restartApp();
  const origin = await app.evaluate('location.origin');
  assert.equal(origin, 'http://tauri.localhost', `unexpected origin ${origin}`);
  if (!(await isAuthenticated())) await enrolDevice();
  assert.ok(await isAuthenticated(), 'the device is not authenticated with the Gateway');
});

await test('the fixture workflow syncs to the device', async () => {
  await navigate('/workflows');
  await waitFor(`!!document.body`, 20_000);
  workflowId = await findWorkflowId();
  assert.ok(workflowId, 'the fixture never appeared in the local library');
});

await test('opening a workflow lands on the form, not the canvas', async () => {
  await navigate(`/workflow/${workflowId}`);
  await waitFor(`!!document.querySelector('[data-form-view]')`, 45_000, 'the form view');
  const state = await app.evaluate(`JSON.stringify({
    fields: [...document.querySelectorAll('[data-form-field]')].map((e) => e.dataset.formField),
    sections: [...document.querySelectorAll('[data-form-section]')].map((e) => e.dataset.formSection),
    formPressed: document.querySelector('[data-e2e-view="form"]')?.getAttribute('aria-pressed'),
  })`).then(JSON.parse);

  assert.equal(state.formPressed, 'true', 'the header switch does not show the form as active');
  assert.ok(state.fields.includes('5:text'), `the prompt is not on the form: ${state.fields}`);
  assert.ok(state.fields.includes('8:seed') && state.fields.includes('8:steps'), 'sampler inputs missing');
  assert.ok(state.fields.includes('7:width') && state.fields.includes('7:height'), 'size inputs missing');
  // The point of the form: a KSampler's plumbing stays off it.
  assert.ok(!state.fields.includes('8:sampler_name'), 'sampler_name should not be suggested');
  assert.ok(state.sections.length >= 3, `expected several sections, got ${state.sections}`);
});

await test('an edit on the form changes the value the workflow will run with', async () => {
  const applied = await setNumericField('8:steps', 6);
  assert.match(applied, /\b6\b/, `steps did not take the new value: ${applied}`);
});

await test('linking two inputs makes one control write both nodes', async () => {
  const linked = await app.evaluate(`(async () => {
    document.querySelector('[data-form-edit-toggle]').click();
    await new Promise((r) => setTimeout(r, 500));
    const width = [...document.querySelectorAll('[data-form-field]')].find((e) => e.dataset.formField === '7:width');
    width.querySelector('[data-form-link]').click();
    await new Promise((r) => setTimeout(r, 800));
    document.querySelector('[data-form-picker-node="7"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const selfEntry = document.querySelector('[data-form-picker-widget="7:width"]');
    const height = document.querySelector('[data-form-picker-widget="7:height"]');
    const selfBlocked = !!selfEntry?.disabled;
    height.click();
    await new Promise((r) => setTimeout(r, 300));
    document.querySelector('[data-form-picker-confirm]').click();
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('[data-form-edit-toggle]').click();
    await new Promise((r) => setTimeout(r, 500));
    return JSON.stringify({
      selfBlocked,
      fields: [...document.querySelectorAll('[data-form-field]')].map((e) => e.dataset.formField),
    });
  })()`).then(JSON.parse);

  assert.ok(linked.selfBlocked, 'the picker offered the field its own widget to link to');
  assert.ok(linked.fields.includes('7:width'), 'the primary field disappeared');
  assert.ok(!linked.fields.includes('7:height'), 'the linked widget still has its own field');

  // Change width; height must follow, and the form must not report a mismatch.
  const after = await app.evaluate(`(async () => {
    const field = () => document.querySelector('[data-form-field="7:width"]');
    field().querySelector('button').click();
    await new Promise((r) => setTimeout(r, 600));
    const input = field().querySelector('input[type=number]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '768');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    [...field().querySelectorAll('button')].find((b) => /Save|保存|저장|保存する/.test(b.innerText)).click();
    await new Promise((r) => setTimeout(r, 1000));
    return JSON.stringify({
      widthText: field().innerText.replace(/\\n/g, ' | '),
      mismatchShown: !!document.querySelector('[data-form-unify]'),
    });
  })()`).then(JSON.parse);

  assert.match(after.widthText, /768/, `width did not take the new value: ${after.widthText}`);
  assert.equal(after.mismatchShown, false, 'the linked input drifted instead of following the primary');
});

await test('the structure view shows the same edit on the node itself', async () => {
  await app.evaluate(`document.querySelector('[data-e2e-view="structure"]').click(); 'switched'`);
  await waitFor(`!document.querySelector('[data-form-view]') && !!document.querySelector('canvas')`, 20_000, 'the canvas');

  const values = await app.evaluate(`(async () => {
    const search = [...document.querySelectorAll('button')].find((b) => b.querySelector('svg.lucide-search'));
    search.click();
    await new Promise((r) => setTimeout(r, 800));
    const input = [...document.querySelectorAll('input')].find((i) => /node/i.test(i.placeholder || ''));
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'EmptySD3');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    [...document.querySelectorAll('button')].filter((b) => /EmptySD3/.test(b.innerText))[0].click();
    await new Promise((r) => setTimeout(r, 1600));
    const text = document.body.innerText;
    return JSON.stringify({
      width: (text.match(/width[\\s\\S]{0,160}?Value:\\s*([0-9]+)/) || [])[1],
      height: (text.match(/height[\\s\\S]{0,160}?Value:\\s*([0-9]+)/) || [])[1],
      pins: [...document.querySelectorAll('[data-form-pin]')].map((e) => e.dataset.formPin + '=' + e.getAttribute('aria-pressed')),
    });
  })()`).then(JSON.parse);

  assert.equal(values.width, '768', `the canvas node shows width ${values.width}`);
  assert.equal(values.height, '768', 'the linked height did not reach the node');
  assert.ok(values.pins.includes('7:width=true'), `pin state missing: ${values.pins}`);
  assert.ok(values.pins.includes('7:height=true'), 'a linked widget should read as pinned');
});

await test('pinning from the node panel adds and removes a form input', async () => {
  const toggled = await app.evaluate(`(async () => {
    const pin = () => document.querySelector('[data-form-pin="7:batch_size"]');
    const before = pin().getAttribute('aria-pressed');
    pin().click();
    await new Promise((r) => setTimeout(r, 1200));
    const afterUnpin = pin().getAttribute('aria-pressed');
    pin().click();
    await new Promise((r) => setTimeout(r, 1200));
    return JSON.stringify({ before, afterUnpin, afterRepin: pin().getAttribute('aria-pressed') });
  })()`).then(JSON.parse);

  assert.equal(toggled.before, 'true', 'batch_size was expected on the suggested form');
  assert.equal(toggled.afterUnpin, 'false', 'unpinning did not take effect');
  assert.equal(toggled.afterRepin, 'true', 'repinning did not take effect');
});

await test('the form survives an app restart and reaches the server', async () => {
  const local = await readStoredSpec(workflowId);
  assert.equal(local?.mode, 'custom', 'the edited form was not stored as a custom spec');
  const widthField = local.sections.flatMap((section) => section.fields)
    .find((field) => field.target.widget === 'width');
  assert.deepEqual(widthField?.linked?.map((t) => `${t.nodeId}:${t.widget}`), ['7:height'],
    'the link is missing from the stored spec');

  await restartApp();
  await navigate(`/workflow/${workflowId}`);
  await waitFor(`!!document.querySelector('[data-form-view]')`, 45_000, 'the form after restart');
  const restored = await app.evaluate(`JSON.stringify({
    fields: [...document.querySelectorAll('[data-form-field]')].map((e) => e.dataset.formField),
    autoHint: !!document.querySelector('[data-form-view]')?.innerText.match(/automatically|自动|自動|자동/),
  })`).then(JSON.parse);
  assert.ok(restored.fields.includes('7:width'), 'the form did not come back');
  assert.ok(!restored.fields.includes('7:height'), 'the link did not survive the restart');
  assert.equal(restored.autoHint, false, 'a stored custom form should not show the auto-suggestion hint');

  // The spec rides the workflow file, so cloud sync carries it to the server.
  let serverSpec = null;
  for (let attempt = 0; attempt < 30 && !serverSpec; attempt += 1) {
    const response = await admin(`/comfymobile/api/workflows/content/${encodeURIComponent(filename)}`);
    if (response.ok) {
      const body = await response.json();
      const wf = body.workflow || body.content || body;
      serverSpec = (typeof wf === 'string' ? JSON.parse(wf) : wf)?.extra?.comfy_mobile_form || null;
    }
    if (!serverSpec) await sleep(2_000);
  }
  assert.ok(serverSpec, 'the form never reached the server copy of the workflow');
  assert.equal(serverSpec.mode, 'custom');
});

await test('a run started from the form produces a real image with the form\'s values', async () => {
  // Android sends every request through the Tauri HTTP plugin, so the page has
  // no XHR/fetch to intercept. Verify against the server instead — which also
  // makes this a black-box check of what was really submitted.
  // The restart above dropped the unsaved values on purpose — only the form
  // definition is persisted — so set them again before running.
  const steps = await setNumericField('8:steps', 6);
  assert.match(steps, /\b6\b/, `could not set steps after the restart: ${steps}`);
  const width = await setNumericField('7:width', 768);
  assert.match(width, /768/, `could not set width after the restart: ${width}`);

  const clicked = await app.evaluate(`(() => {
    const execute = [...document.querySelectorAll('button')].find((b) => /Execute|执行|実行|실행/.test(b.innerText));
    if (!execute) return 'missing';
    execute.click();
    return 'clicked';
  })()`);
  assert.equal(clicked, 'clicked', 'the form has no execute button');

  const findRun = async () => {
    const response = await admin('/history?max_items=40');
    if (!response.ok) return null;
    const history = await response.json();
    for (const [promptId, run] of Object.entries(history)) {
      const images = Object.values(run.outputs || {}).flatMap((entry) => entry.images || []);
      if (images.some((image) => `${image.subfolder}/${image.filename}`.includes(String(stamp)))) {
        return { promptId, run, image: images[0] };
      }
    }
    return null;
  };

  let found = null;
  for (let attempt = 0; attempt < 90 && !found; attempt += 1) {
    found = await findRun();
    if (!found) await sleep(2_000);
  }
  assert.ok(found, 'the run never produced an image on the server');
  assert.equal(found.run.status?.status_str, 'success', `the run failed: ${JSON.stringify(found.run.status)}`);

  // history[].prompt is [number, prompt_id, prompt, extra, outputs]
  const prompt = found.run.prompt?.[2] || {};
  assert.equal(prompt['8']?.inputs?.steps, 6, `the form's steps edit did not reach the prompt: ${JSON.stringify(prompt['8']?.inputs)}`);
  assert.equal(prompt['7']?.inputs?.width, 768, 'the form width did not reach the prompt');
  assert.equal(prompt['7']?.inputs?.height, 768, 'the linked height did not reach the prompt');
  console.log(`    output: ${found.image.subfolder}/${found.image.filename}`);
});

// ---- Teardown --------------------------------------------------------------

try {
  const outputDir = new URL('../output/form-view-android/', import.meta.url);
  await mkdir(outputDir, { recursive: true });
  const png = await adb('exec-out', 'screencap', '-p').then((r) => r.stdout);
  await writeFile(new URL('result.png', outputDir), Buffer.from(png, 'binary'));
} catch { /* a screenshot is a nicety, not a result */ }

await deleteFixtureWorkflow();
app?.socket?.close();

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const entry of failed) console.log(`  ✗ ${entry.name}: ${entry.error}`);
  process.exitCode = 1;
}
