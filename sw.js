// Perch service worker
// 1. App shell: navigations and config.js are network-first (3 s timeout → cache), everything else is
//    stale-while-revalidate, so deploys reach installed phones while the app still opens offline.
// 2. Streams Drive media: ./media/<fileId> → Drive alt=media with the OAuth token and the Range header,
//    so <video> can seek without downloading whole files.
// Bump VERSION on every deploy.
const VERSION = 'perch-v5';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './config.js', './css/app.css',
  './js/main.js', './js/util.js', './js/icons.js', './js/store.js', './js/auth.js', './js/drive.js',
  './js/mockdrive.js', './js/eagle.js', './js/thumbs.js', './js/grid.js', './js/sheet.js', './js/layers.js', './js/viewer.js', './js/install.js', './js/framestep.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
];
const DRIVE = 'https://www.googleapis.com/drive/v3/files/';
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);
const SCOPE = new URL(self.registration.scope);

const NET_TIMEOUT = 3000;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache so a fresh deploy is what gets precached.
  event.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('perch-v') && key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  if (rel.startsWith('media/')) { event.respondWith(media(req, decodeURIComponent(rel.slice(6)))); return; }
  if (req.method !== 'GET' || rel.startsWith('demo/') || rel.startsWith('__')) return;
  if (req.mode === 'navigate') {
    // Only the app itself; opening e.g. a screenshot in a tab goes straight to the network.
    if (rel === '' || rel === 'index.html') event.respondWith(networkFirst(req, { key: SCOPE.href, navigate: true }));
    return;
  }
  if (rel === 'config.js') { event.respondWith(networkFirst(req)); return; }
  // On localhost always serve fresh files; elsewhere answer from cache and refresh it in the background.
  event.respondWith(DEV ? networkFirst(req, { timeout: 0 }) : staleWhileRevalidate(event, req));
});

/** Network first; after `timeout` ms (or on failure) fall back to the cached copy. */
async function networkFirst(req, { key = req, navigate = false, timeout = NET_TIMEOUT } = {}) {
  const cache = await caches.open(VERSION);
  // A navigate-mode Request can't be re-issued with init options, so fetch navigations by URL.
  const network = fetch(req.mode === 'navigate' ? req.url : req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  network.catch(() => {}); // a late failure after we've answered from cache is fine
  const cached = async () => (await cache.match(key, { ignoreSearch: true })) ||
    (navigate ? cache.match(new URL('index.html', SCOPE).href) : undefined);
  let timer = 0;
  try {
    if (!timeout) return await network;
    const first = await Promise.race([network, new Promise((r) => { timer = setTimeout(r, timeout, null); })]);
    if (first) return first;
    return (await cached()) || (await network); // slow network and nothing cached: keep waiting
  } catch {
    return (await cached()) || Response.error();
  } finally {
    clearTimeout(timer);
  }
}

/** Answer from cache immediately (when we have it) and update the cache for next time. */
async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  });
  if (hit) {
    event.waitUntil(network.catch(() => {}));
    return hit;
  }
  try { return await network; } catch { return Response.error(); }
}

// Small JSON values written by the page (auth token, mode, demo media map).
let kvMemo = { t: 0, v: {} };
async function kv(key, { fresh = false } = {}) {
  const now = Date.now();
  if (now - kvMemo.t > 2000) kvMemo = { t: now, v: {} };
  if (!fresh && key in kvMemo.v) return kvMemo.v[key];
  let value = null;
  try {
    const c = await caches.open('perch-kv');
    const r = await c.match(new URL(`__kv/${key}`, SCOPE).href);
    value = r ? await r.json() : null;
  } catch { /* ignore */ }
  kvMemo.v[key] = value;
  return value;
}

async function media(req, id) {
  if (id === '__ping') return new Response(null, { status: 204 });
  const range = req.headers.get('range');
  const mode = await kv('mode', { fresh: true });
  if (mode && mode.mode === 'demo') {
    const map = await kv('demo-map');
    const src = map && map[id];
    if (!src) return new Response('Not found', { status: 404 });
    return fetch(src, { headers: range ? { Range: range } : {} });
  }
  // The token is read fresh every time: right after a renew the page has just stored a new one.
  let auth = await kv('auth', { fresh: true });
  if (!auth || !auth.token) return new Response('Sign in required', { status: 401 });
  const get = (tok) => {
    const headers = { Authorization: `Bearer ${tok}` };
    if (range) headers.Range = range;
    return fetch(`${DRIVE}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers });
  };
  try {
    let res = await get(auth.token);
    if (res.status === 401) {
      const again = await kv('auth', { fresh: true });   // a renew may have landed meanwhile
      if (again && again.token && again.token !== auth.token) res = await get(again.token);
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}
