import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ComfyAdapter, ComfyRequestError } from '../../workflow/comfyAdapter.js';

test('workflow read-back validates authenticated paths, missing/error distinction, ETags and response limits', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++; const url = new URL(req.url!, 'http://localhost');
    assert.equal(url.searchParams.get('token'), 'synthetic-auth');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/missing.json')) { res.statusCode = 404; res.end(JSON.stringify({ status: 'error' })); }
    else if (url.pathname.endsWith('/error.json')) { res.statusCode = 503; res.end(JSON.stringify({ status: 'error' })); }
    else if (url.pathname.endsWith('/large.json')) { res.setHeader('content-length', String(9 * 1024 * 1024)); res.end('{}'); }
    else if (url.pathname.endsWith('/invalid.json')) res.end(JSON.stringify({ status: 'success', content: {} }));
    else { assert.equal(decodeURIComponent(url.pathname), '/comfymobile/api/workflows/content/folder/猫.json'); res.end(JSON.stringify({ status: 'success', etag: 'abc', content: { nodes: [], links: [] } })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const adapter = new ComfyAdapter({ comfyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, comfyAuthToken: 'synthetic-auth' });
  try {
    assert.equal((await adapter.getWorkflow('folder/猫.json'))?.etag, 'abc');
    assert.equal(await adapter.getWorkflow('missing.json'), null);
    for (const [name, status] of [['error', 503], ['large', 413], ['invalid', 502]] as const) await assert.rejects(adapter.getWorkflow(`${name}.json`), error => error instanceof ComfyRequestError && error.status === status);
    const before = calls;
    await assert.rejects(adapter.getWorkflow('../private.json')); await assert.rejects(adapter.getWorkflow('/absolute.json'));
    assert.equal(calls, before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
