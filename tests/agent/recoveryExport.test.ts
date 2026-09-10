import test from 'node:test';
import assert from 'node:assert/strict';
import { exportRecoveryJson } from '../../src/platform/recoveryExport';

test('native recovery export preserves JSON bytes, treats cancellation as normal, and reports write failure', async () => {
  const globals = globalThis as unknown as { isTauri?: boolean; window?: unknown };
  const previousRuntime = globals.isTauri; const previousWindow = globals.window;
  const calls: unknown[][] = []; let outcome: 'save' | 'cancel' | 'error' = 'save';
  globals.isTauri = true;
  globals.window = { __TAURI_INTERNALS__: { invoke: async (...args: unknown[]) => {
    calls.push(args); if (outcome === 'error') throw new Error('provider refused');
    return { saved: outcome === 'save' };
  } } };
  try {
    const contents = JSON.stringify({ prompt: '海边的猫 🐱', revision: 2 }, null, 2);
    assert.equal(await exportRecoveryJson('draft-recovery.json', contents), true);
    assert.deepEqual(calls[0].slice(0, 2), ['plugin:media-download|save_json_file', { payload: { filename: 'draft-recovery.json', contents } }]);
    outcome = 'cancel'; assert.equal(await exportRecoveryJson('draft-recovery.json', contents), false);
    outcome = 'error'; await assert.rejects(exportRecoveryJson('draft-recovery.json', contents), /无法导出恢复备份/);
    const before = calls.length;
    await assert.rejects(exportRecoveryJson('draft-recovery.json', '猫'.repeat(3 * 1024 * 1024)), /恢复文件不能超过 8 MB/);
    assert.equal(calls.length, before, 'UTF-8 size must be checked before opening a document picker');
  } finally {
    if (previousRuntime === undefined) delete globals.isTauri; else globals.isTauri = previousRuntime;
    if (previousWindow === undefined) delete globals.window; else globals.window = previousWindow;
  }
});
