// Treffly service worker: keeps the app usable offline. Generated at build time (see vite.config.ts).
// Nothing is sent anywhere; it only caches files of this site in the visitor's browser.
const VERSION = '__VERSION__';
const SHELL = __SHELL__; // app files with hashed names, safe to serve from the cache
const DATA = __DATA__; // small data files needed to start
const CACHE = `treffly-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([...SHELL, ...DATA])).then(() => self.skipWaiting()));
});

// Each deploy rebuilds the timetable, so old caches are removed as a whole (old and new data never mix).
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('treffly-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // map tiles etc. go straight to the network
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (req.mode === 'navigate') {
    // page: network first so updates arrive, cached copy when offline
    e.respondWith(fetch(req).then((res) => { putCopy('./', res); return res; }).catch(() => caches.match('./', { cacheName: CACHE, ignoreVary: true, ignoreSearch: true })));
  } else if (rel.startsWith('assets/') || rel.startsWith('icons/')) {
    e.respondWith(caches.match(req, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit || fetch(req).then((res) => { putCopy(req, res); return res; })));
  } else if (rel.startsWith('data/') || rel === 'manifest.webmanifest') {
    // data: network first (always the current timetable), cache as fallback; every file used is kept for offline use
    e.respondWith(fetch(req).then((res) => { putCopy(req, res); return res; }).catch(() => caches.match(req, { cacheName: CACHE, ignoreVary: true }).then((hit) => hit || Response.error())));
  }
});

// The page lists data files it loaded before this worker was running (first visit).
self.addEventListener('message', (e) => {
  const urls = (e.data && e.data.keep) || [];
  const own = urls.filter((u) => typeof u === 'string' && new URL(u).origin === location.origin && new URL(u).pathname.includes('/data/'));
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(own.map((u) => c.match(u, { ignoreVary: true }).then((hit) => hit || c.add(u).catch(() => {}))))));
});

function putCopy(key, res) {
  if (!res || !res.ok) return;
  const copy = res.clone();
  caches.open(CACHE).then((c) => c.put(key, copy));
}
