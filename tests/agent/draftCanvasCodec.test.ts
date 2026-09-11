import test from 'node:test';
import { buildSync } from 'esbuild';
import { spawnSync } from 'node:child_process';
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
    // The child must not inherit this runner's own test-runner context: with
    // NODE_TEST_CONTEXT set it reports over the V8 channel instead of stdout
    // and exits 0, so every inner assertion would pass silently. tsx's loader
    // hooks go too — the bundle is plain JavaScript and does not need them.
    const { NODE_TEST_CONTEXT, NODE_OPTIONS, TSX_TSCONFIG_PATH, ...env } = process.env;
    // Run the bundle directly rather than through a nested `--test`: the app
    // modules log freely, and the nested runner parses its child's stdout as a
    // report stream, so a stray write there took the whole file down.
    const result = spawnSync(process.execPath, [outfile], { timeout: 20_000, encoding: 'utf8', env });
    const report = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0 || !/^# pass \d+/m.test(report)) {
      const summary = report.split('\n').filter((line) => /^(not ok |# (tests|pass|fail) )/.test(line)).join('\n');
      throw new Error(`draft codec suite failed (exit ${result.status})\n${summary || report.slice(-2000)}`);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
