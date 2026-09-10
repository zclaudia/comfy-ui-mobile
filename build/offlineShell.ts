import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export interface ShellResource { path: string; digest: string }
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Only build-owned public assets are cached. API responses and media never enter this cache. */
export function shellWorker(resources: ShellResource[]): string {
  const version = hash(JSON.stringify(resources));
  return `
const PREFIX = 'comfy-mobile-shell-';
const CACHE = PREFIX + '${version}';
const resources = ${JSON.stringify(resources)}.map(item => ({ ...item, url: new URL(item.path, self.registration.scope).href }));
const urls = new Set(resources.map(item => item.url));
const indexURL = new URL('index.html', self.registration.scope).href;
const scope = new URL(self.registration.scope);
async function prepare() {
  const responses = await Promise.all(resources.map(async item => {
    const response = await fetch(item.url, { cache: 'reload', credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('Offline shell download failed');
    const digest = await crypto.subtle.digest('SHA-256', await response.clone().arrayBuffer());
    const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== item.digest) throw new Error('Offline shell build changed during installation');
    return [item.url, response];
  }));
  const cache = await caches.open(CACHE);
  await Promise.all(responses.map(([url, response]) => cache.put(url, response)));
}
self.addEventListener('install', event => {
  // Do not skip waiting: an upgrade must not replace the runtime beneath an open editor.
  event.waitUntil(prepare().catch(async error => { await caches.delete(CACHE); throw error; }));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    await Promise.all((await caches.keys()).filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  // Deliberately allow only app pages. ComfyUI, login, file downloads and APIs pass through.
  const page = /^(?:$|index\\.html$|chats\\/?$|chat\\/(?:new|[0-9a-f-]+)(?:\\/versions\\/\\d+|\\/drafts\\/[0-9a-f-]+\\/canvas)?\\/?$|workflows\\/?$|workflow\\/[^/]+\\/?$|outputs\\/?$|settings(?:\\/[^/]+)?\\/?$)/i.test(path);
  if (request.mode === 'navigate' && page) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(indexURL)) || fetch(request))());
  } else if (urls.has(url.href)) {
    event.respondWith((async () => (await (await caches.open(CACHE)).match(url.href)) || fetch(request))());
  }
});
self.addEventListener('message', event => {
  if (!['OFFLINE_SHELL_STATUS', 'OFFLINE_SHELL_PREPARE'].includes(event.data?.type) || !event.ports[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let ready = (await Promise.all(resources.map(item => cache.match(item.url)))).every(Boolean);
    if (!ready && event.data.type === 'OFFLINE_SHELL_PREPARE') {
      try { await prepare(); ready = true; } catch { /* Existing cached files and local drafts remain untouched. */ }
    }
    event.ports[0].postMessage({ ready, version: '${version}' });
  })());
});
`;
}

/** Use final files so index HTML, lazy chunks and the worker describe exactly the same build. */
export function offlineShellPlugin(): Plugin {
  let directory = '';
  return {
    name: 'comfy-mobile-offline-shell', apply: 'build', enforce: 'post',
    configResolved(config) { directory = resolve(config.root, config.build.outDir); },
    async writeBundle(_options, bundle) {
      const publicAssets = ['manifest.json', ...[16, 32, 72, 96, 128, 144, 152, 192, 384, 512].map(size => `icons/comfy-mobile-app-icon-v4-${size}x${size}.png`)];
      const paths = [...new Set(['index.html', ...Object.keys(bundle).filter(path => path.startsWith('assets/') && !path.endsWith('.map')), ...publicAssets])].sort();
      const resources = await Promise.all(paths.map(async path => ({ path, digest: hash(await readFile(resolve(directory, path))) })));
      await writeFile(resolve(directory, 'service-worker.js'), shellWorker(resources));
    },
  };
}
