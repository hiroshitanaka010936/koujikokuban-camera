// オフライン動作用。アプリ本体のファイルだけを端末に保存し、外部とは通信しない。
// 写真データはここを通りません（IndexedDB に暗号化保存）。
const CACHE = 'kokuban-v1.0.0';
const FILES = [
  './', 'index.html', 'styles.css', 'app.js', 'crypto.js', 'db.js', 'board.js', 'jpegmeta.js', 'zip.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
