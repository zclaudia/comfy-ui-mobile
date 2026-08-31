import { isTauriRuntime } from './runtime';

export const platformFetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
    return tauriFetch(input, init);
  }
  return globalThis.fetch(input, init);
};
