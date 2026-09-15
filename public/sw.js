const CACHE = 'streaming-service-v4';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Never cache WebSocket upgrades or API calls
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api') || url.pathname === '/stream') return;

  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
