// Airhop service worker. vite.config.ts fills in PRECACHE (every file of the build) and VERSION
// (a hash of their contents) and writes the result to dist/sw.js.
//
// - Install: cache the whole app up front, so it works offline straight after the first visit.
// - Navigations: always answered with the cached app shell, whatever the query or hash.
// - Updates: a new version installs in the background and waits; the page offers a reload. It
//   never swaps files under an open page, so a transfer in progress is never broken by a deploy.

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const CACHE = `airhop-${VERSION}`;
const SHELL = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // cache: 'reload' bypasses the HTTP cache so a fresh deploy is never mixed with stale files.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      // Nothing to protect on a first install, so take over immediately.
      if (!self.registration.active) await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('airhop-') && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
  if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === 'navigate') {
        const shell = await cache.match(SHELL);
        if (shell) return shell;
        return fetch(req);
      }
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && url.pathname.startsWith(new URL(SHELL).pathname)) cache.put(req, res.clone());
      return res;
    })(),
  );
});
