// Network-first service worker with a cache fallback, so Airhop keeps working offline (the
// whole point on an air-gapped device) once it has been loaded once.
const CACHE = 'airhop-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = (await cache.match(req, { ignoreSearch: true })) ?? (req.mode === 'navigate' ? await cache.match('./') : undefined);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
