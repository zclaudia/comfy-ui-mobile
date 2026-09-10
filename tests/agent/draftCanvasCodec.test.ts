import test from 'node:test';
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

test('mobile canvas graph serialization remains compatible with the gateway codec', () => {
  // Bundle the actual browser graph modules, supplying only their environment
  // bootstrap. No graph/serializer/compiler methods are replaced by fixtures.
  const directory = mkdtempSync(join(process.cwd(), 'node_modules/.draft-codec-test-'));
  try {
    const outfile = join(directory, 'codec.mjs');
    buildSync({ entryPoints: ['tests/fixtures/draftCanvasCodec.ts'], outfile, tsconfig: 'tsconfig.app.json',
      bundle: true, platform: 'node', format: 'esm', packages: 'external', define: { 'import.meta.env': '{}' },
      banner: { js: 'globalThis.window={location:{origin:"http://localhost",pathname:"/chat/test/drafts/test/canvas"},addEventListener(){},removeEventListener(){}};' } });
    execFileSync(process.execPath, ['--test', outfile], { timeout: 20_000, stdio: 'pipe' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
