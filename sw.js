// オフライン動作用。アプリ本体のファイルだけを端末に保存し、外部とは通信しない。
// 写真データはここを通りません（IndexedDB に暗号化保存）。
const NAMESPACE = 'kokuban:' + self.registration.scope + ':';
const CACHE = NAMESPACE + '2.0.0';
const FILES = [
  './', 'index.html', 'styles.css', 'auth.js', 'app.js', 'crypto.js', 'db.js', 'board.js', 'jpegmeta.js', 'zip.js',
  'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(path => new Request(path, {cache:'reload'}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter(k => k.startsWith(NAMESPACE) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.href.startsWith(self.registration.scope)) return;
  e.respondWith(
    caches.open(CACHE).then(c => c.match(e.request, {ignoreSearch:true})).then(hit => hit || fetch(e.request))
  );
});
