import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

const gatewayUrl = (process.env.LIVE_GATEWAY_URL || 'https://comfy.zhvala.space:28443').replace(/\/$/, '');
const gatewayToken = process.env.GATEWAY_AUTH_TOKEN?.trim();

if (!gatewayToken) throw new Error('GATEWAY_AUTH_TOKEN is required');

const authHeaders = { Authorization: `Bearer ${gatewayToken}` };
const request = (path, options = {}) => fetch(`${gatewayUrl}${path}`, {
  ...options,
  headers: { ...authHeaders, ...(options.headers || {}) },
});

const readJson = async (response) => {
  const body = await response.json();
  assert.ok(response.ok, `${response.url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const workflowPath = (filename) => filename
  .split('/')
  .map((part) => encodeURIComponent(part))
  .join('/');

const save = (filename, content, expectedEtag) => request('/comfymobile/api/workflows/save', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    filename,
    content,
    overwrite: false,
    ...(expectedEtag ? { expected_etag: expectedEtag } : {}),
  }),
});

test('cloud workflow protocol through the public Gateway', { timeout: 30_000 }, async (t) => {
  const filename = `ComfyMobileE2E/Cloud_Protocol_${randomUUID()}.json`;
  const original = {
    last_node_id: 0,
    last_link_id: 0,
    nodes: [],
    links: [],
    groups: [],
    config: {},
    extra: { name: 'Cloud protocol E2E', revision: 1 },
    version: 0.4,
  };
  let cleanupEtag;

  t.after(async () => {
    const response = await request(`/comfymobile/api/workflows/content/${workflowPath(filename)}`, {
      method: 'DELETE',
      headers: cleanupEtag ? { 'If-Match': cleanupEtag } : {},
    });
    if (response.status !== 404 && !response.ok) {
      t.diagnostic(`Cleanup failed (${response.status}): ${await response.text()}`);
    }
  });

  await t.test('create returns a strong content ETag', async () => {
    const created = await readJson(await save(filename, original));
    assert.equal(created.status, 'success');
    assert.equal(created.filename, filename);
    assert.match(created.etag, /^[a-f0-9]{64}$/);
    cleanupEtag = created.etag;
  });

  await t.test('list and content return the same ETag and content', async () => {
    const listing = await readJson(await request('/comfymobile/api/workflows/list'));
    const listed = listing.workflows.find((workflow) => workflow.filename === filename);
    assert.ok(listed, `${filename} was not in the cloud listing`);
    assert.equal(listed.etag, cleanupEtag);

    const downloaded = await readJson(await request(
      `/comfymobile/api/workflows/content/${workflowPath(filename)}`,
    ));
    assert.equal(downloaded.etag, cleanupEtag);
    assert.deepEqual(downloaded.content, original);
  });

  await t.test('stale save is rejected and current save advances the ETag', async () => {
    const changed = { ...original, extra: { ...original.extra, revision: 2 } };
    const stale = await save(filename, changed, '0'.repeat(64));
    assert.equal(stale.status, 409);
    const staleBody = await stale.json();
    assert.equal(staleBody.code, 'workflow_conflict');
    assert.equal(staleBody.current_etag, cleanupEtag);

    const saved = await readJson(await save(filename, changed, cleanupEtag));
    assert.match(saved.etag, /^[a-f0-9]{64}$/);
    assert.notEqual(saved.etag, cleanupEtag);
    cleanupEtag = saved.etag;
  });

  await t.test('stale delete is rejected and current delete succeeds', async () => {
    const endpoint = `/comfymobile/api/workflows/content/${workflowPath(filename)}`;
    const stale = await request(endpoint, {
      method: 'DELETE',
      headers: { 'If-Match': '0'.repeat(64) },
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'workflow_conflict');

    const deleted = await readJson(await request(endpoint, {
      method: 'DELETE',
      headers: { 'If-Match': cleanupEtag },
    }));
    assert.equal(deleted.status, 'success');
    cleanupEtag = undefined;

    const missing = await request(endpoint);
    assert.equal(missing.status, 404);
  });
});
