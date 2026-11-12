// Perch service worker
// 1. App shell: answered from the cache at once and refreshed in the background (stale-while-revalidate),
//    so the app opens instantly, also when coming back from Google. A deploy installs a new worker that
//    precaches the new shell; the next launch runs it.
// 2. Streams Drive media: ./media/<fileId> → Drive alt=media with the OAuth token and the Range header,
//    so <video> can seek without downloading whole files.
// 3. Keeps small videos (≤ 30 MB) whole in a media cache (LRU, 600 MB): the first play streams and fills
//    the cache at the same time, replays and seeks then come from the phone, and the viewer asks for the
//    next and previous videos ahead of time (X-Perch-Prefetch) so swiping to them starts at once.
// 4. Share target: a video shared from another app (POST ./share-target) is kept in the 'perch-share' cache
//    and the app opens to upload it to Drive; a shared link goes on to the app as ?share_url=….
// Bump VERSION on every deploy.
const VERSION = 'perch-v13';
const MEDIA_CACHE = 'perch-media';
const MEDIA_MAX_FILE = 30 * 1024 * 1024;
const MEDIA_BUDGET = 600 * 1024 * 1024;
const SHARE_CACHE = 'perch-share';
const SHELL = [
  './', './index.html', './manifest.webmanifest', './config.js', './css/app.css',
  './js/main.js', './js/util.js', './js/icons.js', './js/store.js', './js/auth.js', './js/drive.js',
  './js/mockdrive.js', './js/eagle.js', './js/thumbs.js', './js/grid.js', './js/sheet.js', './js/layers.js', './js/viewer.js', './js/install.js', './js/framestep.js', './js/inbox.js', './js/uploads.js', './js/bridge.js', './js/pending.js',
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
    await mediaIndex();   // drops cache entries the index doesn't know (and index entries without data)
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return;
  const rel = url.pathname.slice(SCOPE.pathname.length);
  if (rel.startsWith('media/')) { event.respondWith(media(event, req, decodeURIComponent(rel.slice(6)))); return; }
  if (req.method === 'POST' && rel === 'share-target') { event.respondWith(receiveShare(req)); return; }
  if (req.method !== 'GET' || rel.startsWith('demo/') || rel.startsWith('__')) return;
  if (req.mode === 'navigate') {
    // Only the app itself; opening e.g. a screenshot in a tab goes straight to the network.
    if (rel !== '' && rel !== 'index.html') return;
    event.respondWith(DEV ? networkFirst(req, { key: SCOPE.href, navigate: true, timeout: 0 }) : shellFromCache(event, req));
    return;
  }
  // On localhost always serve fresh files; elsewhere answer from cache and refresh it in the background.
  event.respondWith(DEV ? networkFirst(req, { timeout: 0 }) : staleWhileRevalidate(event, req));
});

/** Something was shared to Perch from another app. Files wait in the share cache; links go on as before. */
async function receiveShare(req) {
  const back = new URL('./', SCOPE);
  let stored = 0;
  try {
    const form = await req.formData();
    const text = ['share_url', 'share_text', 'share_title'].map((k) => [k, String(form.get(k) || '')]).filter(([, v]) => v);
    const files = form.getAll('file').filter((f) => f && typeof f === 'object' && f.size > 0);
    if (files.length) {
      const link = (text.map(([, v]) => v).join(' ').match(/https?:\/\/[^\s<>"']+/i) || [''])[0];
      const cache = await caches.open(SHARE_CACHE);
      const t = Date.now();
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const id = `${t + i}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
        await cache.put(new URL(`__share/${id}`, SCOPE).href, new Response(f, { headers: {
          'content-type': f.type || 'application/octet-stream',
          'x-name': encodeURIComponent(f.name || ''),
          'x-size': String(f.size),
          'x-url': encodeURIComponent(link),
        } }));
        stored++;
      }
      back.searchParams.set('shared', String(stored));
    } else {
      for (const [k, v] of text) back.searchParams.set(k, v);
      if (!text.length) back.searchParams.set('shared', 'empty');
    }
  } catch (e) {
    // Some files may be in already (a later one didn't fit): say how many, so those still upload.
    back.searchParams.set('shared', stored ? String(stored) : 'failed');
  }
  return Response.redirect(back.href, 303);
}

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

/** The app page: from the cache at once (refreshed in the background), from the network the first time. */
async function shellFromCache(event, req) {
  const cache = await caches.open(VERSION);
  const hit = (await cache.match(SCOPE.href)) || (await cache.match(new URL('index.html', SCOPE).href));
  if (!hit) return networkFirst(req, { key: SCOPE.href, navigate: true });
  event.waitUntil(fetch(req.url, { cache: 'no-cache' })
    .then((res) => (res.ok ? cache.put(SCOPE.href, res) : null))
    .catch(() => {}));
  return hit;
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

// ── media ────────────────────────────────────────────────────────────────────
const mediaKey = (mode, id) => new URL(`__media/${mode}/${encodeURIComponent(id)}`, SCOPE).href;
const inflight = new Map();   // key → promise of a whole-file download into the media cache

/** Fetch a file from where it lives (Drive with the token, or the demo files), with an optional Range. */
async function upstream(mode, id, range) {
  if (mode === 'demo') {
    const map = await kv('demo-map');
    const src = map && map[id];
    if (!src) return new Response('Not found', { status: 404 });
    return fetch(src, { headers: range ? { Range: range } : {} });
  }
  // The token is read fresh every time: right after a renew the page has just stored a new one.
  const auth = await kv('auth', { fresh: true });
  if (!auth || !auth.token) return new Response('Sign in required', { status: 401 });
  const get = (tok) => {
    const headers = { Authorization: `Bearer ${tok}` };
    if (range) headers.Range = range;
    return fetch(`${DRIVE}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers });
  };
  let res = await get(auth.token);
  if (res.status === 401) {
    const again = await kv('auth', { fresh: true });   // a renew may have landed meanwhile
    if (again && again.token && again.token !== auth.token) res = await get(again.token);
  }
  return res;
}

async function media(event, req, id) {
  if (id === '__ping') return new Response(null, { status: 204 });
  const range = req.headers.get('range');
  const m = await kv('mode', { fresh: true });
  const mode = m && m.mode === 'demo' ? 'demo' : 'drive';
  const key = mediaKey(mode, id);
  try {
    // Prefetch from the viewer: fill the cache in the background and answer at once.
    if (req.headers.get('x-perch-prefetch')) {
      const size = Number(req.headers.get('x-perch-size')) || 0;
      // Answer once the whole file is in, so the viewer's one-at-a-time prefetch really limits downloads.
      if (size <= MEDIA_MAX_FILE && !(await cachedMedia(key, event))) {
        const p = wholeFile(mode, id, key);
        event.waitUntil(p);
        await p.catch(() => {});
      }
      return new Response(null, { status: 204 });
    }
    const hit = await cachedMedia(key, event);
    if (hit) return sliceResponse(hit, range);

    const res = await upstream(mode, id, range);
    if (!res.ok || !res.body) return res;
    const total = totalSize(res);
    if (!total || total > MEDIA_MAX_FILE || inflight.has(key)) return res;
    if (coversWholeFile(res, total)) {
      // This response is the whole file: play it and keep a copy, from one download.
      const [play, keep] = res.body.tee();
      const p = putMedia(key, new Response(keep, { headers: { 'Content-Type': res.headers.get('content-type') || '' } }), total);
      track(key, p);
      event.waitUntil(p);
      return new Response(play, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    // A slice (Safari probes bytes=0-1 first, seeks ask for the middle): fetch the whole file alongside.
    event.waitUntil(wholeFile(mode, id, key));
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

const totalSize = (res) => {
  const cr = res.headers.get('content-range');
  if (cr) { const n = Number(cr.split('/')[1]); return Number.isFinite(n) ? n : 0; }
  return res.status === 200 ? Number(res.headers.get('content-length')) || 0 : 0;
};
const coversWholeFile = (res, total) => {
  if (res.status === 200) return true;
  const m = /bytes (\d+)-(\d+)\//.exec(res.headers.get('content-range') || '');
  return !!m && Number(m[1]) === 0 && Number(m[2]) === total - 1;
};

function track(key, p) {
  const q = p.catch(() => {}).finally(() => { if (inflight.get(key) === q) inflight.delete(key); });
  inflight.set(key, q);
  return q;
}

/** Download the whole file into the media cache (once at a time per file). */
function wholeFile(mode, id, key) {
  if (inflight.has(key)) return inflight.get(key);
  return track(key, (async () => {
    const res = await upstream(mode, id, null);
    if (res.status !== 200 || !res.body) return;
    const total = Number(res.headers.get('content-length')) || 0;
    if (total > MEDIA_MAX_FILE) { res.body.cancel().catch(() => {}); return; }
    await putMedia(key, new Response(res.body, { headers: { 'Content-Type': res.headers.get('content-type') || '' } }), total);
  })());
}

async function cachedMedia(key, event) {
  try {
    const c = await caches.open(MEDIA_CACHE);
    const hit = await c.match(key);
    if (hit) event.waitUntil(touch(key));   // the index write stays inside the event's lifetime
    return hit || null;
  } catch { return null; }
}

/** Answer a (Range) request from a whole cached file. */
async function sliceResponse(hit, range) {
  const type = hit.headers.get('content-type') || 'application/octet-stream';
  const blob = await hit.blob();
  const total = blob.size;
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (m[1] === '' && m[2] === '')) return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(total) } });
  let start, end;
  if (m[1] === '') { start = Math.max(0, total - Number(m[2])); end = total - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1); }
  if (start >= total || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) },
  });
}

// LRU index of the media cache: key → { size, used }. Kept in the kv cache.
let indexP = null;
let indexSave = null;   // { timer, p, resolve } of the debounced index write
let evicting = Promise.resolve();   // evictions run one after another, each from the current index
function mediaIndex() {
  if (!indexP) indexP = (async () => {
    let idx = {};
    try {
      const c = await caches.open('perch-kv');
      const r = await c.match(new URL('__kv/media-index', SCOPE).href);
      idx = (r && (await r.json())) || {};
      const mc = await caches.open(MEDIA_CACHE);
      const keys = new Set((await mc.keys()).map((k) => k.url));
      for (const k of Object.keys(idx)) if (!keys.has(k)) delete idx[k];
      for (const k of keys) if (!idx[k]) await mc.delete(k);
    } catch { /* start empty */ }
    return idx;
  })();
  return indexP;
}
async function writeIndex() {
  try {
    const idx = await mediaIndex();
    const c = await caches.open('perch-kv');
    await c.put(new URL('__kv/media-index', SCOPE).href, new Response(JSON.stringify(idx), { headers: { 'content-type': 'application/json' } }));
  } catch { /* ignore */ }
}
/** Write the index soon (a burst of touches writes once). Resolves when written, so callers can waitUntil it. */
function saveIndex() {
  if (!indexSave) {
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    indexSave = { p, resolve, timer: 0 };
  }
  const s = indexSave;
  clearTimeout(s.timer);
  s.timer = setTimeout(() => { if (indexSave === s) indexSave = null; writeIndex().then(s.resolve); }, 800);
  return s.p;
}
async function touch(key) {
  const idx = await mediaIndex();
  if (idx[key]) { idx[key].used = Date.now(); return saveIndex(); }
}

async function putMedia(key, res, total) {
  const c = await caches.open(MEDIA_CACHE);
  await c.put(key, res);                       // settles once the whole body has arrived
  const run = evicting.then(async () => {
    const idx = await mediaIndex();
    idx[key] = { size: total, used: Date.now() };
    let sum = Object.values(idx).reduce((a, e) => a + (e?.size || 0), 0);
    for (const [k] of Object.entries(idx).sort((a, b) => a[1].used - b[1].used)) {
      if (sum <= MEDIA_BUDGET) break;
      if (k === key || !idx[k]) continue;
      sum -= idx[k]?.size || 0;
      delete idx[k];
      await c.delete(k);
    }
    await writeIndex();
  });
  evicting = run.catch(() => {});
  return run;
}
