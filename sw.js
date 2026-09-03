// Minimal service worker. Its only real job is to satisfy the browser's
// "installable PWA" checklist (manifest + HTTPS + a registered service
// worker) so Chrome/Android offer "Install app". It also caches the app
// shell so the page still opens (showing a login/loading screen) if you're
// briefly offline — actual data always comes from the network, this never
// caches or intercepts calls to the Supabase API (different origin).

const CACHE = 'traty-shell-v1';
const SHELL = ['./', './index.html', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let API calls go straight to the network
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((r) => r || caches.match('./index.html')))
  );
});
