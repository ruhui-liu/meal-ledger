// 离线缓存：没信号也能打开网站、看缓存的账、先记账（联网后自动同步）
// - 带 ?v= 版本号的 JS/CSS：缓存优先（版本号变了就是新文件）
// - 其他同源请求（页面、图标、数据）：网络优先，失败时用缓存
const CACHE = 'meal-ledger-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-180.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 清掉旧版本号的 JS/CSS，避免缓存越积越多
    const c = await caches.open(CACHE);
    const keys = await c.keys();
    const latest = {};
    for (const k of keys) {
      const u = new URL(k.url), v = u.searchParams.get('v');
      if (!v) continue;
      if (!latest[u.pathname] || v > latest[u.pathname]) latest[u.pathname] = v;
    }
    await Promise.all(keys.filter((k) => { const u = new URL(k.url), v = u.searchParams.get('v'); return v && v !== latest[u.pathname]; }).map((k) => c.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;
  if (u.searchParams.has('v')) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req)) || (req.mode === 'navigate' ? caches.match('./') : Response.error())));
});
