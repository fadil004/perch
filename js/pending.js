// Videos sent from the phone that Eagle hasn't added yet. They show in "All" like any other reference
// (same tile, same viewer) until Eagle on the computer imports them; then the real item takes over.
// Two sources: files still on the phone (the upload queue, played from the phone's copy) and 'file'
// requests in the Drive inbox that aren't done, played from the video next to them in Drive.
import { lsGet, lsSet } from './util.js';
import { thumbStore } from './store.js';
import { fileRequests } from './inbox.js';
import { waiting } from './uploads.js';

const META_KEY = 'perch.pendmeta';                       // stem -> { w, h, d, thumb } of a video sent from here
const LIST_KEY = (modeKey) => `perch.pending.${modeKey}`;   // the last Drive answer, for an instant first paint
export const thumbKey = (stem) => `pend:${stem}`;
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'avif', 'bmp']);
const NOTE_DRIVE = 'On Drive · Eagle adds it when it opens on your computer';

const extOf = (name, type) => (/\.([a-z0-9]{1,8})$/i.exec(name || '') || [])[1]?.toLowerCase() || (String(type).split('/')[1] || 'mp4').replace('quicktime', 'mov');
const stemTime = (stem) => Number(String(stem).slice(0, 13)) || 0;

/** An Eagle-like item for the grid and the viewer (see normalizeItem in eagle.js). */
function toItem({ stem, name, type, size, url, sentAt, main, meta = {}, note, upload = null }) {
  const ext = extOf(name, type);
  const kind = ext === 'gif' ? 'gif' : /^image\//.test(type || '') || IMAGE.has(ext) ? 'image' : 'video';
  const t = Date.parse(sentAt || '') || stemTime(stem);
  return {
    id: `pending-${stem}`,
    name: String(name || 'Video').replace(/\.[a-z0-9]{1,8}$/i, ''),
    ext, kind,
    w: meta.w || 0,
    h: meta.h || 0,
    ratio: 16 / 9,             // height/width until the real size is known (phone videos are mostly upright)
    size: Number(size) || 0,
    btime: t, mtime: t,
    tags: [], folders: [], url: url || '', note: '', star: 0,
    duration: meta.d || 0, medium: '', videoID: '', pal: [],
    f: { info: null, thumb: meta.thumb ? thumbKey(stem) : null, main, thumbV: '', mainV: '' },
    _hay: '',
    pending: { stem, note, upload },
  };
}

// ── a frame from the phone's copy, as the thumbnail (and its size and length) ──
let chain = Promise.resolve();
const once = (el, ev, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout')), ms);
  el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true });
  el.addEventListener('error', () => { clearTimeout(t); rej(new Error('unreadable')); }, { once: true });
});
async function frameOf(blob, type) {
  const canvas = document.createElement('canvas');
  const fit = (w, h) => { const k = Math.min(1, 640 / Math.max(w, h)); canvas.width = Math.round(w * k); canvas.height = Math.round(h * k); };
  if (/^image\//.test(type)) {
    const bmp = await createImageBitmap(blob);
    fit(bmp.width, bmp.height);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = { w: bmp.width, h: bmp.height, d: 0 };
    bmp.close();
    return { ...out, jpeg: await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82)) };
  }
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  try {
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await once(v, 'loadeddata', 8000);
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    if (d > 0.4) { v.currentTime = Math.min(0.5, d / 4); await once(v, 'seeked', 4000); }   // past a black first frame
    fit(v.videoWidth, v.videoHeight);
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height);
    return { w: v.videoWidth, h: v.videoHeight, d, jpeg: await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.82)) };
  } finally {
    v.removeAttribute('src'); v.load();
    URL.revokeObjectURL(url);
  }
}
/** Thumbnail + size + length for a file sent from this phone (once per file, one at a time). */
function capture(stem, file) {
  chain = chain.then(async () => {
    if (lsGet(META_KEY, {})[stem]) return;
    let m = { w: 0, h: 0, d: 0, thumb: 0 };   // a file the browser can't decode keeps the plain tile (no retry)
    try {
      const f = await frameOf(await file.blob(), file.type);
      if (f.jpeg) await thumbStore.put(thumbKey(stem), f.jpeg);
      m = { w: f.w, h: f.h, d: Math.round(f.d * 100) / 100, thumb: f.jpeg ? 1 : 0 };
    } catch { /* see above */ }
    const all = lsGet(META_KEY, {});
    all[stem] = m;
    lsSet(META_KEY, all);
  }).catch(() => {});
  return chain;
}

/** Drive's own thumbnail for a video sent from another device (or before this phone kept one). */
async function driveThumb(stem, link, token) {
  const url = link.replace(/=s\d+$/, '=s640');
  let res = await fetch(url, { referrerPolicy: 'no-referrer' }).catch(() => null);
  if ((!res || !res.ok) && token) res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res || !res.ok) return false;
  const blob = await res.blob();
  if (!/^image\//.test(blob.type)) return false;
  await thumbStore.put(thumbKey(stem), blob);
  const all = lsGet(META_KEY, {});
  all[stem] = { ...(all[stem] || {}), thumb: 1 };
  lsSet(META_KEY, all);
  return true;
}

const sameLibrary = (req, libName) => {
  const lib = String(req.library || '').replace(/\.library$/i, '').trim().toLowerCase();
  return !lib || lib === String(libName || '').replace(/\.library$/i, '').trim().toLowerCase();
};

/**
 * The items to show, newest first. `uploads` is the upload queue's list (status/sent per stem);
 * `network: false` answers from what's on the phone plus the last Drive answer (instant, offline).
 * Resolves with { items, done } — done: stems Eagle has added (to notice one turning done).
 */
export async function collectPending({ drive, modeKey, libName, uploads = [], network = true, token = '' }) {
  const meta = () => lsGet(META_KEY, {});
  // 1. still on this phone (stashed, uploading)
  const local = await waiting();
  for (const w of local) if (!meta()[w.id]) await capture(w.id, w);
  const state = new Map(uploads.map((u) => [u.id, u]));
  const items = local.map((w) => {
    const u = state.get(w.id);
    const upload = u && u.status === 'uploading' ? { sent: u.sent || 0, size: u.size || w.size } : { sent: 0, size: w.size };
    const note = u && u.status === 'error' ? `On this phone · couldn’t upload yet (${u.error || 'error'})` : 'On this phone · uploading to Drive, then Eagle adds it';
    return toItem({ stem: w.id, name: w.name, type: w.type, size: w.size, url: w.url, main: `local:${w.id}`, meta: meta()[w.id], note, upload });
  });
  // 2. in the Drive inbox, not added to Eagle yet
  let reqs = null;
  if (network && drive) { try { reqs = await fileRequests(drive, modeKey); } catch { /* offline: the last answer */ } }
  if (reqs) lsSet(LIST_KEY(modeKey), reqs.filter((r) => r.status !== 'done' && r.status !== 'error').slice(0, 60));
  const list = reqs || lsGet(LIST_KEY(modeKey), []) || [];
  const onPhone = new Set(local.map((w) => w.id));
  const fetchThumbs = [];
  for (const r of list) {
    if (r.status === 'done' || r.status === 'error' || onPhone.has(r.stem) || !r.video || !sameLibrary(r, libName)) continue;
    const v = r.video;
    let m = meta()[r.stem];
    if (!m) {
      const vm = v.videoMediaMetadata || v.imageMediaMetadata || {};
      m = { w: Number(vm.width) || 0, h: Number(vm.height) || 0, d: (Number(vm.durationMillis) || 0) / 1000, thumb: 0 };
    }
    if (!m.thumb && v.thumbnailLink && network) fetchThumbs.push([r.stem, v.thumbnailLink]);
    const it = toItem({ stem: r.stem, name: r.name || r.file, type: r.mimeType, size: r.size || v.size, url: r.url, sentAt: r.sentAt, main: v.id, meta: m, note: NOTE_DRIVE });
    // Until a copy is kept, the tile can still show Drive's thumbnail straight from its link (no CORS needed).
    if (!m.thumb && v.thumbnailLink) it.thumbUrl = v.thumbnailLink.replace(/=s\d+$/, '=s640');
    items.push(it);
  }
  // Forget sizes/thumbnails of videos that are gone from both places (Eagle has them now).
  if (reqs) {
    const live = new Set([...onPhone, ...reqs.filter((r) => r.status !== 'done' && r.status !== 'error').map((r) => r.stem)]);
    const all = meta();
    const stale = Object.keys(all).filter((k) => !live.has(k) && Date.now() - stemTime(k) > 10 * 60_000);
    if (stale.length) { for (const k of stale) delete all[k]; lsSet(META_KEY, all); }
  }
  items.sort((a, b) => b.pending.stem.localeCompare(a.pending.stem));
  const thumbs = fetchThumbs.length
    ? Promise.all(fetchThumbs.slice(0, 12).map(([stem, link]) => driveThumb(stem, link, token).catch(() => false))).then((r) => r.some(Boolean))
    : Promise.resolve(false);
  return { items, done: reqs ? reqs.filter((r) => r.status === 'done').map((r) => r.stem) : [], thumbs };
}

/**
 * Hide a pending item once the library has it (Eagle imported it, the sync already brought it in, but the
 * request isn't marked done yet): same source link or same name, added after it was sent.
 */
export function notInLibrary(pending, items) {
  if (!pending.length) return pending;
  const since = new Map();
  for (const it of items) {
    for (const k of [it.url && `u:${it.url}`, it.name && `n:${it.name.toLowerCase()}`]) if (k && (since.get(k) || 0) < it.btime) since.set(k, it.btime);
  }
  return pending.filter((p) => {
    const t = p.btime - 60_000;
    return !((p.url && (since.get(`u:${p.url}`) || 0) >= t) || (since.get(`n:${p.name.toLowerCase()}`) || 0) >= t);
  });
}
