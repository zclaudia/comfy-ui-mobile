import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { isTauriRuntime } from './runtime';

/** Write-only native capability: copying a code block never reads the user's clipboard. */
export async function copyText(text: string): Promise<void> {
  if (isTauriRuntime()) await writeText(text);
  else await navigator.clipboard.writeText(text);
}
