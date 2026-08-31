import axios from 'axios';
import { isTauri } from '@tauri-apps/api/core';

export type AppRuntime = 'web' | 'tauri';

export const isTauriRuntime = (): boolean => isTauri();

export const getAppRuntime = (): AppRuntime => (
  isTauriRuntime() ? 'tauri' : 'web'
);

/**
 * Route Axios through Tauri's Rust HTTP client on Android. This keeps the
 * browser build unchanged while avoiding WebView CORS and cookie limitations
 * in the installed application.
 */
export const initializePlatformRuntime = async (): Promise<void> => {
  if (!isTauriRuntime()) return;

  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
  axios.defaults.adapter = 'fetch';
  axios.defaults.env = {
    ...axios.defaults.env,
    fetch: tauriFetch,
  };
};
