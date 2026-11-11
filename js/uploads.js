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

const EXT = {
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'video/3gpp': '3gp',
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic',
};
function extOf(name, type) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
  return (m ? m[1] : EXT[type] || 'bin').toLowerCase();
}

/** Keep files on the phone until they're in Drive. Resolves with how many were kept. */
export async function stash(files, { url = '' } = {}) {
  const cache = await caches.open(SHARE_CACHE);
  const t = Date.now();
  let n = 0;
  for (const f of files) {
    if (!f || !f.size) continue;
    await cache.put(keyUrl(newStem(t + n)), new Response(f, { headers: {
      'content-type': f.type || 'application/octet-stream',
      'x-name': encodeURIComponent(f.name || ''),
      'x-size': String(f.size),
      'x-url': encodeURIComponent(url),
    } }));
    n++;
  }
  return n;
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

/**
 * One upload at a time, in order. ctx() says where to: { drive, modeKey, library, writable }.
 * onChange(items) on every step (and on progress); items: { id, name, size, sent, status, error }
 * with status 'waiting' | 'uploading' | 'saved' | 'error'.
 */
export function createUploader({ ctx, onChange = () => {}, onSaved = () => {} }) {
  const items = new Map();
  let running = null;
  const list = () => [...items.values()];
  const emit = () => onChange(list());

  const track = (w) => {
    if (!items.has(w.id)) items.set(w.id, { id: w.id, name: w.name, size: w.size, sent: 0, status: 'waiting', error: '' });
    return items.get(w.id);
  };

  async function uploadOne(w, { drive, modeKey, library }, again = false) {
    const it = track(w);
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
      try {
        f = await drive.sendUpload(meta.session, blob, { fresh, onProgress: (sent) => { it.sent = sent; emit(); } });
      } catch (e) {
        // Drive forgot the session (older than a week, or it went wrong): start once more from zero.
        if (e.name === 'DriveError' && e.status === 410 && !again) {
          lsSet(metaKey(w.id), { folder: meta.folder });
          return uploadOne(w, { drive, modeKey, library }, true);
        }
        throw e;
      }
      meta.fileId = f.id;
      lsSet(metaKey(w.id), meta);
    }
    it.sent = it.size;
    await saveFileRequest(drive, meta.folder, { stem: w.id, file, name: w.name || file, size: w.size, mimeType, url: w.url, library });
    await (await caches.open(SHARE_CACHE)).delete(keyUrl(w.id));
    lsSet(metaKey(w.id), null);
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
        for (const w of pending) track(w);
        emit();
        const c = ctx();
        if (!c.writable || !c.drive) break;
        const w = pending.find((x) => items.get(x.id).status !== 'error');
        if (!w) break;
        try {
          await uploadOne(w, c);
        } catch (e) {
          const it = items.get(w.id);
          it.status = 'error';
          it.error = e.name === 'AuthError' ? 'Google sign-in expired' : (e.message || 'Upload failed');
          it.scope = e.name === 'DriveError' && e.status === 403 && /insufficient|scope|permission/i.test(e.message);
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
    /** Try the failed ones again. */
    retry() { for (const it of items.values()) if (it.status === 'error') it.status = 'waiting'; return run(); },
    /** Forget finished rows (when the sheet closes). */
    clearSaved() { for (const [id, it] of items) if (it.status === 'saved') items.delete(id); },
    /** Look at the cache without uploading (to show what's waiting). */
    async refresh() { for (const w of await waiting()) track(w); emit(); return list(); },
  };
}
