import { invoke } from '@tauri-apps/api/core';
import { isTauriRuntime } from './runtime';

/** Android's system document picker can save local JSON without a server or storage permission. */
export async function exportRecoveryJson(filename: string, contents: string): Promise<boolean> {
  if (new TextEncoder().encode(contents).byteLength > 8 * 1024 * 1024) throw new Error('恢复文件不能超过 8 MB');
  if (isTauriRuntime()) {
    try {
      const result = await invoke<{ saved: boolean }>('plugin:media-download|save_json_file', { payload: { filename, contents } });
      return result.saved;
    } catch { throw new Error('无法导出恢复备份，请重试'); }
  }
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = document.body.appendChild(document.createElement('a'));
  try { link.download = filename; link.href = url; link.click(); return true; }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}
