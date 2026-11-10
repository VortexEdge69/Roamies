// Caches the app shell so the client opens instantly (and shows "offline" instead of an error page).
// API calls always go to the network.
const SHELL = 'jarvis-shell-v2';
const FILES = ['/', '/index.html', '/app.js', '/sphere.js', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/v1/') || u.pathname === '/health') return;
  // Network first, so updates show up; the cache is the fallback.
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(SHELL).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});
