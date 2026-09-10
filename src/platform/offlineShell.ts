import { isTauriRuntime } from './runtime';

type ShellStatus = 'checking' | 'ready' | 'unavailable' | 'bundled' | 'development';
let status: ShellStatus = import.meta.env.DEV ? 'development' : 'checking';
const listeners = new Set<() => void>();
export const offlineShellSnapshot = () => status;
export const subscribeOfflineShell = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const publish = (value: ShellStatus) => { if (value !== status) { status = value; listeners.forEach(listener => listener()); } };
let registration: Promise<void> | undefined;
let probe = 0;

async function checkWorker(prepare = false) {
  const current = ++probe;
  const worker = navigator.serviceWorker.controller;
  if (!worker) { publish('unavailable'); return; }
  const channel = new MessageChannel();
  const timer = setTimeout(() => { channel.port1.close(); if (current === probe) publish('unavailable'); }, prepare ? 20_000 : 3000);
  channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); if (current === probe) publish(event.data?.ready === true ? 'ready' : 'unavailable'); };
  worker.postMessage({ type: prepare ? 'OFFLINE_SHELL_PREPARE' : 'OFFLINE_SHELL_STATUS' }, [channel.port2]);
}

/** Registration never reloads the page or forces a waiting update to replace an active editor. */
export function registerOfflineShell(): Promise<void> {
  if (registration) return registration;
  registration = (async () => {
    if (isTauriRuntime()) { publish('bundled'); return; }
    if (import.meta.env.DEV) { publish('development'); return; }
    if (!window.isSecureContext || !('serviceWorker' in navigator)) { publish('unavailable'); return; }
    navigator.serviceWorker.addEventListener('controllerchange', () => void checkWorker());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void checkWorker(); });
    // Register/update may wait on an unreachable origin. The existing controller can still prove offline readiness.
    if (navigator.serviceWorker.controller) void checkWorker();
    try {
      const base = new URL(import.meta.env.BASE_URL, window.location.origin);
      const result = await navigator.serviceWorker.register(new URL('service-worker.js', base), { scope: base.pathname, updateViaCache: 'none' });
      if (navigator.serviceWorker.controller) await checkWorker(true);
      else if (!result.installing && !result.active) publish('unavailable');
      const worker = result.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'redundant') publish('unavailable'); });
    } catch { if (navigator.serviceWorker.controller) void checkWorker(); else publish('unavailable'); }
  })();
  return registration;
}
