const CACHE_NAME = 'carlog-beta-0.9.21';
const ASSETS = [
  './',
  './index.html',
  './calc.js',
  './Code.gs',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(ASSETS.map((url) => cache.add(url)));
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

async function resolveOfflineNavigation(request) {
  const m1 = await caches.match('./index.html');
  if (m1) return m1;
  const m2 = await caches.match('./');
  if (m2) return m2;
  const m3 = await caches.match(request);
  if (m3) return m3;
  return new Response(
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><title>CarLog オフライン</title></head><body style="background:#0c0e11;color:#e9e6df;font-family:sans-serif;padding:24px;text-align:center;"><h2>CarLog オフライン</h2><p>接続を確認して再読み込みしてください。</p><button onclick="location.reload()" style="padding:10px 20px;background:#dfac58;border:none;border-radius:6px;font-weight:700;">再読み込み</button></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cachedResponse = await caches.match(event.request);
    const fetchPromise = fetch(event.request, { cache: 'no-cache' })
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => null);
    event.waitUntil(fetchPromise.then(() => {}));
    if (cachedResponse) return cachedResponse;

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Network timeout')), 2500)
    );
    try {
      const netRes = await Promise.race([fetchPromise, timeoutPromise]);
      if (netRes) return netRes;
    } catch (e) {}

    if (event.request.mode === 'navigate') {
      return await resolveOfflineNavigation(event.request);
    }
    const fallbackMatch = await caches.match(event.request);
    if (fallbackMatch) return fallbackMatch;
    return new Response('Offline', { status: 503, statusText: 'Offline' });
  })());
});
