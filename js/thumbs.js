// Thumbnail loader: memory → IndexedDB → Drive. Visible tiles jump the queue (LIFO); a low-priority
// FIFO lane quietly warms the cache so the library also works offline.
import { thumbStore } from './store.js';

let drive = null;
const mem = new Map();       // fileId -> object URL, least recently used first
const inflight = new Map();  // fileId -> Promise<url|null>
const warming = new Map();   // fileId -> Promise (background download into IndexedDB only)
const MAX_URLS = 600;        // object URLs kept alive; older ones are released
const WARM_URLS = 400;       // the background warm-up keeps URLs only up to here, beyond it just the offline copy
const waiting = new Map();   // fileId -> queued job (not started yet)
const high = [];             // LIFO: most recently requested (visible) first
const low = [];              // FIFO: background warm-up
let active = 0;
const LIMIT = 6;
let generation = 0;

export function setThumbSource(d) {
  drive = d;
  generation++;
  for (const job of [...high, ...low]) job.resolve(null);
  high.length = 0;
  low.length = 0;
  waiting.clear();
}

export function cachedThumb(id) {
  const url = id ? mem.get(id) : null;
  if (!url) return null;
  mem.delete(id);
  mem.set(id, url);          // most recently used
  return url;
}

function remember(id, url) {
  mem.set(id, url);
  while (mem.size > MAX_URLS) {
    const [oldId, oldUrl] = mem.entries().next().value;
    mem.delete(oldId);
    setTimeout(() => URL.revokeObjectURL(oldUrl), 30_000);   // an <img> may still be about to read it
  }
}

function pump() {
  while (active < LIMIT && (high.length || low.length)) {
    const job = high.length ? high.pop() : low.shift();
    waiting.delete(job.id);
    if (job.gen !== generation) { job.resolve(null); continue; }
    active++;
    job.run().then(job.resolve, () => job.resolve(null)).finally(() => { active--; pump(); });
  }
}

function enqueue(id, run, lane) {
  return new Promise((resolve) => {
    const job = { id, run, resolve, gen: generation, lane };
    waiting.set(id, job);
    (lane === 'low' ? low : high).push(job);
    pump();
  });
}

function promote(id) {
  const job = waiting.get(id);
  if (!job || job.lane !== 'low') return;
  const i = low.indexOf(job);
  if (i >= 0) low.splice(i, 1);
  job.lane = 'high';
  high.push(job);
  pump();
}

/** `id` is a cache key: "<driveFileId>|<version>" (or a bare file id). */
export function loadThumb(id, lane = 'high') {
  if (!id) return Promise.resolve(null);
  if (mem.has(id)) return Promise.resolve(cachedThumb(id));
  if (inflight.has(id)) { if (lane === 'high') promote(id); return inflight.get(id); }
  if (warming.has(id)) { if (lane === 'high') promote(id); return warming.get(id).then(() => loadThumb(id, lane)); }
  const p = (async () => {
    let blob = null;
    try { blob = await thumbStore.get(id); } catch { /* storage unavailable */ }
    if (!blob) {
      if (!drive) return null;
      const source = drive;
      const fileId = id.split('|')[0];
      blob = await enqueue(id, () => source.blob(fileId), lane);
      if (!blob) return null;
      thumbStore.put(id, blob).catch(() => {});
    }
    const url = URL.createObjectURL(blob);
    remember(id, url);
    return url;
  })().catch(() => null).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Warm the cache for the whole library, politely, after the first paint. */
export function prefetch(ids) {
  if (navigator.connection && navigator.connection.saveData) return;
  const gen = generation;
  let i = 0;
  const idle = window.requestIdleCallback ? (fn) => requestIdleCallback(fn, { timeout: 1000 }) : (fn) => setTimeout(fn, 200);
  const step = () => {
    if (gen !== generation) return;
    const batch = ids.slice(i, i + 24);
    i += 24;
    Promise.all(batch.map((id) => (mem.has(id) ? null : mem.size < WARM_URLS ? loadThumb(id, 'low') : warm(id)))).then(() => {
      if (i < ids.length) idle(step);
    });
  };
  setTimeout(step, 1500);
}

/** Make sure the offline copy exists, without holding the image in memory. */
function warm(id) {
  if (!id || inflight.has(id) || warming.has(id)) return null;
  const p = (async () => {
    try { if (await thumbStore.has(id)) return; } catch { return; }
    if (!drive) return;
    const source = drive;
    const blob = await enqueue(id, () => source.blob(id.split('|')[0]), 'low');
    if (blob) await thumbStore.put(id, blob).catch(() => {});
  })().catch(() => {}).finally(() => warming.delete(id));
  warming.set(id, p);
  return p;
}

const versioned = (id, v) => (v ? `${id}|${v}` : id);
export const thumbIdOf = (it) => {
  if (it.f.thumb) return versioned(it.f.thumb, it.f.thumbV);
  if ((it.kind === 'image' || it.kind === 'gif') && it.f.main) return versioned(it.f.main, it.f.mainV);
  return null;
};
