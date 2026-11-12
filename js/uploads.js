// Videos sent from the phone to Eagle: the phone already has the file, so it goes to Drive as it is and
// Video Grabber only has to add it to the library — the computer downloads nothing from the web.
//
// A shared or picked file is first kept in the 'perch-share' cache (the service worker stores files shared
// from other apps the same way), so closing Perch mid-upload loses nothing: the next launch carries on, and
// Drive's resumable upload sessions continue from the last byte Drive has.
import { lsGet, lsSet } from './util.js';
import { withInbox, saveFileRequest, newStem } from './inbox.js';

export const SHARE_CACHE = 'perch-share';
const STEM = /^\d{13}-[a-z0-9]{6}$/;
const keyUrl = (id) => new URL(`__share/${id}`, document.baseURI).href;
const metaKey = (id) => `perch.up.${id}`;
// Library each file was sent to, fixed the first time it's seen (not whichever library is open when it uploads).
const LIB_KEY = 'perch.up.lib';
const libName = (library) => (library && library.name ? library.name : '');
function libFor(id, library) {
  const all = lsGet(LIB_KEY, {}) || {};
  if (id in all) return all[id];
  if (library) { all[id] = libName(library); lsSet(LIB_KEY, all); }
  return libName(library);
}
function forgetLib(ids) {
  const all = lsGet(LIB_KEY, {}) || {};
  let changed = false;
  for (const id of ids) if (id in all) { delete all[id]; changed = true; }
  if (changed) lsSet(LIB_KEY, Object.keys(all).length ? all : null);
}
const headersFor = ({ name = '', type = '', size = 0, url = '' }) => ({
  'content-type': type || 'application/octet-stream',
  'x-name': encodeURIComponent(name || ''),
  'x-size': String(size),
  'x-url': encodeURIComponent(url || ''),
});

const EXT = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/3gpp': '3gp',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
};
function extOf(name, type) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return (m ? m[1] : EXT[type] || 'bin').toLowerCase();
}

/** Keep files on the phone until they're in Drive. Resolves with how many were kept. */
export async function stash(files, { url = '', library = null } = {}) {
  const cache = await caches.open(SHARE_CACHE);
  const t = Date.now();
  let n = 0;
  for (const f of files) {
    if (!f || !f.size) continue;
    const stem = newStem(t + n);
    if (library) libFor(stem, library);
    await cache.put(keyUrl(stem), new Response(f, { headers: headersFor({ name: f.name, type: f.type, size: f.size, url }) }));
    n++;
  }
  return n;
}

/**
 * Keep a file that arrives as a stream (the phone downloader) the same way `stash` keeps a File, without ever
 * holding it in memory. The entry only exists once the whole body is in (a stream that errors stores nothing).
 * Resolves with { id, blob } (blob: the kept copy, read from the phone's storage).
 */
export async function stashStream(body, { name = '', type = '', size = 0, url = '', library = null, t = Date.now() } = {}) {
  const cache = await caches.open(SHARE_CACHE);
  const stem = newStem(t);
  const key = keyUrl(stem);
  if (library) libFor(stem, library);
  try {
    await cache.put(key, new Response(body, { headers: headersFor({ name, type, size, url }) }));
  } catch (e) {
    forgetLib([stem]);
    throw e;
  }
  let res = await cache.match(key);
  let blob = res ? await res.blob() : null;
  if (!blob) throw new Error('The file is gone from this phone');
  if (blob.size !== size) {   // the length wasn't known up front: write down the real one
    await cache.put(key, new Response(blob, { headers: headersFor({ name, type, size: blob.size, url }) }));
    res = await cache.match(key);
    blob = res ? await res.blob() : blob;
  }
  return { id: stem, blob };
}

/** Files waiting to upload, oldest first. */
export async function waiting() {
  let cache;
  try { cache = await caches.open(SHARE_CACHE); } catch { return []; }
  const out = [];
  for (const req of await cache.keys()) {
    const id = decodeURIComponent(new URL(req.url).pathname.split('/__share/')[1] || '');
    if (!STEM.test(id)) { await cache.delete(req); continue; }
    const res = await cache.match(req);
    if (!res) continue;
    out.push({
      id,
      name: decodeURIComponent(res.headers.get('x-name') || ''),
      type: res.headers.get('content-type') || '',
      size: Number(res.headers.get('x-size')) || 0,
      url: decodeURIComponent(res.headers.get('x-url') || ''),
      // A fresh read each time: a retry may need the bytes again.
      blob: async () => { const r = await cache.match(req); if (!r) throw new Error('The file is gone from this phone'); return r.blob(); },
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Drop every video waiting on this phone (sign-out, after the user agreed). */
export async function clearWaiting() {
  try { await caches.delete(SHARE_CACHE); } catch { /* ignore */ }
  try { for (const k of Object.keys(localStorage)) if (k.startsWith('perch.up.')) localStorage.removeItem(k); } catch { /* ignore */ }
}

/** What kind of failure: 'net' (offline, cut, server trouble) and 'auth' heal by themselves; 'scope' and 'other' don't. */
function failureKind(e) {
  if (e.name === 'AuthError') return 'auth';
  if (e.name === 'DriveError') {
    if (e.status === 403 && /insufficient|scope|permission/i.test(e.message)) return 'scope';
    if (e.status === 0 || e.status === 429 || e.status >= 500) return 'net';
    return 'other';
  }
  return e.name === 'TypeError' ? 'net' : 'other';
}
const BACKOFF_MIN = 30_000, BACKOFF_MAX = 30 * 60_000;

/**
 * One upload at a time, in order. ctx() says where to: { drive, modeKey, library, writable }.
 * onChange(items) on every step (and on progress); items: { id, name, size, sent, status, error }
 * with status 'waiting' | 'uploading' | 'saved' | 'error'.
 */
export function createUploader({ ctx, onChange = () => {}, onSaved = () => {} }) {
  const items = new Map();
  const cancelled = new Set();   // deleted from the phone before it reached Eagle: never upload or ask for it
  let current = null;            // { id, ctl } of the upload in flight
  let running = null;
  const list = () => [...items.values()];
  const emit = () => onChange(list());

  const track = (w) => {
    if (!items.has(w.id)) items.set(w.id, { id: w.id, name: w.name, size: w.size, sent: 0, status: 'waiting', error: '' });
    return items.get(w.id);
  };

  async function uploadOne(w, { drive, modeKey, library }, again = false) {
    const it = track(w);
    const lib = libFor(w.id, library);
    const meta = lsGet(metaKey(w.id)) || {};
    const file = `${w.id}.${extOf(w.name, w.type)}`;
    const mimeType = w.type || 'application/octet-stream';
    it.status = 'uploading';
    it.error = '';
    emit();
    if (!meta.fileId) {
      const blob = await w.blob();
      let fresh = false;
      if (!meta.session) {
        await withInbox(drive, modeKey, async (folder) => {
          meta.session = await drive.startUpload(file, [folder], { mimeType, size: blob.size });
          meta.folder = folder;
        });
        lsSet(metaKey(w.id), meta);
        fresh = true;
      }
      let f;
      const ctl = new AbortController();
      current = { id: w.id, ctl };
      try {
        f = await drive.sendUpload(meta.session, blob, { fresh, signal: ctl.signal, onProgress: (sent) => { it.sent = sent; emit(); } });
      } catch (e) {
        // Drive forgot the session (older than a week, or it went wrong): start once more from zero.
        if (e.name === 'DriveError' && e.status === 410 && !again) {
          lsSet(metaKey(w.id), { folder: meta.folder });
          return uploadOne(w, { drive, modeKey, library }, true);
        }
        throw e;
      } finally {
        current = null;
      }
      if (cancelled.has(w.id)) { await drive.trash(f.id).catch(() => {}); return; }   // finished just as it was deleted
      meta.fileId = f.id;
      lsSet(metaKey(w.id), meta);
    }
    if (cancelled.has(w.id)) return;
    it.sent = it.size;
    if (!meta.requested) {
      await saveFileRequest(drive, meta.folder, { stem: w.id, file, name: w.name || file, size: w.size, mimeType, url: w.url, library: { name: lib } });
      meta.requested = true;   // Perch may close before the next line: never write the request twice
      lsSet(metaKey(w.id), meta);
    }
    await (await caches.open(SHARE_CACHE)).delete(keyUrl(w.id));
    lsSet(metaKey(w.id), null);
    forgetLib([w.id]);
    it.status = 'saved';
    emit();
    onSaved(it);
  }

  /** Upload everything waiting. Safe to call any time; one run at a time. */
  function run() {
    if (running) return running;
    running = (async () => {
      for (;;) {
        const pending = await waiting();
        const c = ctx();
        for (const w of pending) { track(w); libFor(w.id, c.library); }
        emit();
        if (!c.writable || !c.drive) break;
        const w = pending.find((x) => items.get(x.id).status !== 'error' && !cancelled.has(x.id));
        if (!w) break;
        try {
          await uploadOne(w, c);
        } catch (e) {
          if (cancelled.has(w.id)) continue;
          const it = items.get(w.id);
          it.status = 'error';
          it.error = e.name === 'AuthError' ? 'Google sign-in expired' : (e.message || 'Upload failed');
          it.kind = failureKind(e);
          it.scope = it.kind === 'scope';
          // Tried again on its own (resume, back online, a renewed sign-in), each time a little later.
          it.tries = (it.tries || 0) + 1;
          it.nextAt = Date.now() + Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** (it.tries - 1));
          emit();
          if (e.name === 'AuthError' || it.scope) break;
        }
      }
    })().finally(() => { running = null; });
    return running;
  }

  return {
    run,
    list,
    /** Try the failed ones again (the Retry button). */
    retry() { for (const it of items.values()) if (it.status === 'error') { it.status = 'waiting'; it.tries = 0; } return run(); },
    /**
     * Try again on its own what failed for a reason that heals (network, sign-in), not scope or other errors,
     * and not before its backoff is over (`now: true` skips the wait for network errors: back online).
     */
    retrySoft({ now = false } = {}) {
      const t = Date.now();
      for (const it of items.values()) {
        if (it.status !== 'error' || (it.kind !== 'net' && it.kind !== 'auth')) continue;
        if (t >= (it.nextAt || 0) || (now && it.kind === 'net')) it.status = 'waiting';
      }
      return run();
    },
    /** Forget finished rows (when the sheet closes). */
    clearSaved() { for (const [id, it] of items) if (it.status === 'saved') items.delete(id); },
    /**
     * Deleted on the phone before Eagle got it: stop its upload, drop the phone's copy and its upload state.
     * Resolves with the Drive id of a video that was already uploaded but not yet sent to Eagle (to bin it).
     */
    async cancel(id) {
      cancelled.add(id);
      if (current && current.id === id) current.ctl.abort();
      const meta = lsGet(metaKey(id)) || {};
      await (await caches.open(SHARE_CACHE)).delete(keyUrl(id));
      lsSet(metaKey(id), null);
      forgetLib([id]);
      items.delete(id);
      emit();
      return meta.fileId || null;
    },
    /** Look at the cache without uploading (to show what's waiting). */
    async refresh() { const lib = ctx().library; for (const w of await waiting()) { track(w); libFor(w.id, lib); } emit(); return list(); },
  };
}
