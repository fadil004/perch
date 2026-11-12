// Eagle 4 library on Drive: discovery, sync (first + incremental) and the in-memory model.
import { FOLDER } from './drive.js';
import { pool, safeUrl } from './util.js';

const VIDEO = new Set(['mp4', 'mov', 'webm', 'm4v']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'svg', 'avif', 'bmp', 'ico']);
const ANIM = new Set(['gif']);
const SNAPSHOT_VERSION = 3; // v3: thumbnail versions (thumbV/mainV) in item.f
const MAX_NET_FAILS = 8;    // network failures in a row (each already retried) before a sync gives up

export const libName = (folderName) => String(folderName || '').replace(/\.library$/i, '');

// ── discovery ────────────────────────────────────────────────────────────────

export async function discoverLibraries(drive) {
  const pick = (list) => list
    .filter((f) => /\.library$/i.test(f.name))
    .map((f) => ({ id: f.id, name: libName(f.name), modifiedTime: f.modifiedTime }));
  const fields = 'id,name,modifiedTime,parents';
  // Drive's `contains` is token based, so the name query alone can miss libraries, or match only one
  // oddly named one ("Work library.library"). Always merge it with a scan of folder names.
  const [named, scanned] = await Promise.all([
    drive.list(`mimeType='${FOLDER}' and name contains 'library' and trashed=false`, fields),
    drive.list(`mimeType='${FOLDER}' and trashed=false and not name contains '.info'`, fields),
  ]);
  const libs = pick([...named, ...scanned]);
  const seen = new Set();
  return libs.filter((l) => !seen.has(l.id) && seen.add(l.id)).sort((a, b) => a.name.localeCompare(b.name));
}

export function parseFolderLink(text) {
  const s = String(text || '').trim();
  const m = /\/folders\/([\w-]{10,})/.exec(s) || /[?&]id=([\w-]{10,})/.exec(s) || /^([\w-]{10,})$/.exec(s);
  return m ? m[1] : null;
}

/** A pasted link may point at a .library folder or at a folder that contains libraries. */
export async function resolveFolderLink(drive, text) {
  const id = parseFolderLink(text);
  if (!id) throw new Error('That doesn’t look like a Drive folder link.');
  const f = await drive.get(id, 'id,name,mimeType,modifiedTime');
  if (f.mimeType !== FOLDER) throw new Error('That link is not a folder.');
  if (/\.library$/i.test(f.name)) return [{ id: f.id, name: libName(f.name), modifiedTime: f.modifiedTime }];
  const inside = await drive.list(`'${f.id}' in parents and mimeType='${FOLDER}' and trashed=false`, 'id,name,modifiedTime');
  const libs = inside.filter((x) => /\.library$/i.test(x.name)).map((x) => ({ id: x.id, name: libName(x.name), modifiedTime: x.modifiedTime }));
  if (!libs.length) throw new Error('No Eagle library in that folder.');
  return libs;
}

// ── sync ─────────────────────────────────────────────────────────────────────

/** List children of many folders with OR-chained parent queries, shrinking the chunk on "too complex". */
async function listChildren(drive, folderIds, startSize, onStep) {
  const out = new Map();
  const queue = [...folderIds];
  let size = startSize;
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      const ids = queue.splice(0, size);
      const q = `(${ids.map((id) => `'${id}' in parents`).join(' or ')}) and trashed=false`;
      try {
        const files = await drive.list(q, 'id,name,mimeType,parents,size,modifiedTime');
        for (const f of files) for (const p of f.parents || []) { if (!out.has(p)) out.set(p, []); out.get(p).push(f); }
        done += ids.length;
        onStep && onStep(done, folderIds.length);
      } catch (e) {
        // Drive rejects over-long OR chains ("query too complex"); shrink the chunk and retry.
        if ((e.status === 400 || e.status === 403 || e.status >= 500) && ids.length > 1) {
          size = Math.max(1, Math.floor(ids.length / 2));
          queue.unshift(...ids);
        } else throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, Math.ceil(folderIds.length / size) || 1) }, worker));
  return { children: out, size };
}

export function normalizeItem(raw, files, infoId) {
  const ext = String(raw.ext || '').toLowerCase();
  const thumb = files.find((f) => /_thumbnail\.png$/i.test(f.name));
  const mainName = `${raw.name}.${raw.ext}`;
  const main = files.find((f) => f.name === mainName) ||
    files.find((f) => f !== thumb && f.name !== 'metadata.json' && f.mimeType !== FOLDER);
  const w = Number(raw.width || raw.resolutionWidth) || 0;
  const h = Number(raw.height || raw.resolutionHeight) || 0;
  const kind = ext === 'url' ? 'link' : VIDEO.has(ext) ? 'video' : ANIM.has(ext) ? 'gif' : IMAGE.has(ext) ? 'image' : 'file';
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    ext,
    kind,
    w,
    h,
    size: Number(raw.size) || Number(main?.size) || 0,
    btime: Number(raw.btime) || Number(raw.modificationTime) || 0,
    mtime: Number(raw.mtime) || Number(raw.modificationTime) || 0,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : [],
    folders: Array.isArray(raw.folders) ? raw.folders.map(String) : [],
    url: typeof raw.url === 'string' ? raw.url : '',
    note: typeof raw.annotation === 'string' ? raw.annotation : '',
    star: Number(raw.star) || 0,
    duration: Number(raw.duration) || 0,
    medium: raw.medium ? String(raw.medium).toLowerCase() : '',
    videoID: raw.videoID ? String(raw.videoID) : '',
    pal: (Array.isArray(raw.palettes) ? raw.palettes : [])
      .map((p) => (Array.isArray(p?.color) ? p.color.slice(0, 3).map(Number) : null))
      .filter((c) => c && c.length === 3 && c.every(Number.isFinite))
      .slice(0, 6),
    // thumbV/mainV (Drive modifiedTime) version the local thumbnail cache, so a changed file is re-fetched.
    f: { info: infoId, thumb: thumb?.id || null, main: main?.id || null, thumbV: thumb?.modifiedTime || '', mainV: main?.modifiedTime || '' },
  };
}

/**
 * Bring a library snapshot up to date.
 * First sync lists every .info folder; later syncs diff mtime.json and only touch what changed.
 */
export async function syncLibrary(drive, lib, prev, { full = false, onProgress = () => {} } = {}) {
  const t0 = performance.now();
  const reuse = prev && prev.v === SNAPSHOT_VERSION && !full ? prev : null;
  onProgress({ phase: 'start' });

  const root = await drive.list(`'${lib.id}' in parents and trashed=false`, 'id,name,mimeType,modifiedTime,size');
  const file = (n) => root.find((f) => f.name === n && f.mimeType !== FOLDER);
  const metaF = file('metadata.json'), tagsF = file('tags.json'), mtimeF = file('mtime.json');
  const imagesF = root.find((f) => f.name === 'images' && f.mimeType === FOLDER);
  if (!metaF || !imagesF) throw new Error('This folder isn’t an Eagle library.');

  // Bad JSON is tolerated; a file that couldn't be fetched fails the sync (so nothing stale is saved as current).
  const parsed = (fallback) => (e) => { if (e instanceof SyntaxError) return fallback; throw e; };
  const [tree, tags, mtimeRaw] = await Promise.all([
    reuse && reuse.metaModified === metaF.modifiedTime ? reuse.tree : drive.json(metaF.id).then((j) => (Array.isArray(j.folders) ? j.folders : [])),
    !tagsF ? { historyTags: [], starredTags: [] }
      : reuse && reuse.tagsModified === tagsF.modifiedTime ? reuse.tags : drive.json(tagsF.id).catch(parsed({ historyTags: [], starredTags: [] })),
    mtimeF ? drive.json(mtimeF.id).catch(parsed(null)) : null,
  ]);

  let mtimes = null;
  if (mtimeRaw && typeof mtimeRaw === 'object') {
    mtimes = {};
    for (const [k, v] of Object.entries(mtimeRaw)) if (k !== 'all') mtimes[k] = v;
  }

  const items = new Map((reuse ? reuse.items : []).map((it) => [it.id, it]));
  const skipped = { ...(reuse ? reuse.skipped : {}) };
  let infoMap = reuse ? { ...reuse.infoMap } : null;
  let listedInfos = false;

  const listInfos = async () => {
    onProgress({ phase: 'list' });
    const infos = await drive.list(`'${imagesF.id}' in parents and mimeType='${FOLDER}' and trashed=false`, 'id,name');
    const map = {};
    for (const f of infos) if (f.name.endsWith('.info')) map[f.name.slice(0, -5)] = f.id;
    listedInfos = true;
    return map;
  };
  if (!infoMap) infoMap = await listInfos();

  const known = mtimes ? Object.keys(mtimes) : Object.keys(infoMap);
  const knownSet = new Set(known);
  let removed = 0;
  for (const id of [...items.keys()]) if (!knownSet.has(id)) { items.delete(id); removed++; }
  for (const id of Object.keys(skipped)) if (!knownSet.has(id)) delete skipped[id];

  const stamp = (id) => (mtimes ? mtimes[id] : 0);
  // skipped[id]: a stamp (number) = nothing to show for that version (deleted in Eagle, no id), skip until it
  // changes; { m, t } = its folder or metadata.json wasn't on Drive yet (still syncing up): try again after a while.
  const NOT_YET_RETRY = 10 * 60_000;
  const notYet = (id) => { skipped[id] = { m: stamp(id), t: Date.now() }; };
  let need = known.filter((id) => {
    const it = items.get(id);
    if (it) return mtimes ? it._m !== mtimes[id] : false;
    const sk = skipped[id];
    if (sk && typeof sk === 'object') return sk.m !== stamp(id) || Date.now() - sk.t > NOT_YET_RETRY;
    return !(id in skipped) || sk !== stamp(id);
  });
  if (!listedInfos && need.some((id) => !infoMap[id])) infoMap = await listInfos();
  // Listed in mtime.json but no folder on Drive (yet): a known item keeps its old version, a new one waits.
  for (const id of need) if (!infoMap[id] && !items.has(id)) notYet(id);
  need = need.filter((id) => infoMap[id]);

  const total = need.length;
  onProgress({ phase: 'scan', done: 0, total });
  const { children, size: chunk } = await listChildren(drive, need.map((id) => infoMap[id]), reuse?.chunk || 40,
    (d, t) => onProgress({ phase: 'scan', done: d, total: t }));

  // A reference whose metadata couldn't be fetched is counted and left as it was (absent, or its old
  // version), so the next sync tries it again. Many network failures in a row end the sync instead of
  // grinding through the rest.
  let done = 0, fetched = 0, failed = 0, netFails = 0, abort = null;
  const limit = pool(10);
  await Promise.all(need.map((id) => limit(async () => {
    if (abort) return;
    const files = children.get(infoMap[id]) || [];
    const metaFile = files.find((f) => f.name === 'metadata.json');
    try {
      if (!metaFile) { if (!items.has(id)) notYet(id); return; }   // not on Drive yet: a known item keeps its old version
      const raw = await drive.json(metaFile.id);
      netFails = 0;
      fetched++;
      if (raw.isDeleted || !raw.id) { skipped[id] = stamp(id); items.delete(id); return; }
      const it = normalizeItem(raw, files, infoMap[id]);
      it.id = id;
      it._m = mtimes ? mtimes[id] : it.mtime;
      items.set(id, it);
      delete skipped[id];
    } catch (e) {
      if (e.name === 'AuthError') throw e;
      if (e.name === 'DriveError') {
        failed++;
        if (e.status === 0 && ++netFails >= MAX_NET_FAILS) abort = abort || e;
      }
      console.warn('[perch] skipped item', id, e.message);
    } finally {
      onProgress({ phase: 'meta', done: ++done, total });
    }
  })));
  if (abort) throw abort;

  const snap = {
    v: SNAPSHOT_VERSION,
    libId: lib.id,
    name: lib.name,
    tree,
    tags,
    items: [...items.values()],
    skipped,
    infoMap,
    chunk,
    metaModified: metaF.modifiedTime,
    tagsModified: tagsF?.modifiedTime || null,
    lastSync: Date.now(),
    lastFull: reuse ? reuse.lastFull : Date.now(),
  };
  const stats = {
    mode: reuse ? 'incremental' : 'full',
    items: snap.items.length,
    fetched,
    failed,
    removed,
    skipped: Object.keys(skipped).length,
    chunk,
    requests: drive.stats ? drive.stats.requests : undefined,
    ms: Math.round(performance.now() - t0),
  };
  return { snap, stats };
}

// ── model ────────────────────────────────────────────────────────────────────

export class Library {
  constructor(snap) {
    this.snap = snap;
    this.items = snap.items.slice().sort((a, b) => b.btime - a.btime || a.name.localeCompare(b.name));
    this.byId = new Map(this.items.map((it) => [it.id, it]));
    this.folders = new Map();
    const walk = (list, parent, depth) => {
      for (const f of list || []) {
        if (!f || !f.id) continue;
        const node = {
          id: f.id,
          name: String(f.name || 'Untitled'),
          color: f.iconColor || null,
          password: f.password || '',
          tips: f.passwordTips || '',
          parent,
          depth,
          children: [],
        };
        this.folders.set(f.id, node);
        if (parent && this.folders.has(parent)) this.folders.get(parent).children.push(node);
        walk(f.children, f.id, depth + 1);
      }
    };
    walk(snap.tree, null, 0);
    this.roots = (snap.tree || []).map((f) => this.folders.get(f.id)).filter(Boolean);
    for (const it of this.items) {
      it._hay = [it.name, it.ext, it.note, it.url, ...it.tags].join('\n').toLowerCase();
    }
    this.setUnlocked(new Set());
  }

  /** Recompute visibility + counts for the current set of unlocked password folders. */
  setUnlocked(unlocked) {
    this.unlocked = unlocked;
    const lockedCache = new Map();
    const isLocked = (id) => {
      if (lockedCache.has(id)) return lockedCache.get(id);
      let n = this.folders.get(id), locked = false;
      while (n) { if (n.password && !unlocked.has(n.id)) { locked = true; break; } n = this.folders.get(n.parent); }
      lockedCache.set(id, locked);
      return locked;
    };
    this.isLocked = isLocked;
    this.visible = this.items.filter((it) => !it.folders.some(isLocked));
    this.uncategorized = this.visible.filter((it) => !it.folders.some((f) => this.folders.has(f)));
    // Tags only from what's visible, so a locked folder doesn't leak its tags.
    this.tagCount = new Map();
    for (const it of this.visible) for (const t of it.tags) this.tagCount.set(t, (this.tagCount.get(t) || 0) + 1);
    // Subtree counts (items in a folder or any of its descendants)
    this.subtree = new Map();
    const collect = (n) => { const s = [n.id]; for (const c of n.children) s.push(...collect(c)); this.subtree.set(n.id, new Set(s)); return s; };
    this.roots.forEach(collect);
    this.counts = new Map();
    for (const [fid, ids] of this.subtree) {
      let c = 0;
      const pool0 = isLocked(fid) ? [] : this.visible;
      for (const it of pool0) if (it.folders.some((f) => ids.has(f))) c++;
      this.counts.set(fid, c);
    }
  }

  inFolder(fid) {
    const ids = this.subtree.get(fid);
    if (!ids || this.isLocked(fid)) return [];
    return this.visible.filter((it) => it.folders.some((f) => ids.has(f)));
  }

  list(view) {
    if (!view || view.type === 'all') return this.visible;
    if (view.type === 'uncat') return this.uncategorized;
    if (view.type === 'folder') return this.inFolder(view.id);
    return this.visible;
  }

  viewName(view) {
    if (!view || view.type === 'all') return 'All';
    if (view.type === 'uncat') return 'Uncategorized';
    return this.folders.get(view.id)?.name || 'All';
  }

  search(source, query, tags) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    return source.filter((it) => words.every((w) => it._hay.includes(w)) && tags.every((t) => it.tags.includes(t)));
  }

  folderPath(id) {
    const out = [];
    let n = this.folders.get(id);
    while (n) { out.unshift(n); n = this.folders.get(n.parent); }
    return out;
  }
}

// ── link helpers ─────────────────────────────────────────────────────────────

export function embedFor(it) {
  let medium = it.medium, vid = it.videoID;
  if (!vid && safeUrl(it.url)) {
    const u = safeUrl(it.url);
    let m;
    if ((m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/.exec(u))) { medium = 'youtube'; vid = m[1]; }
    else if ((m = /vimeo\.com\/(?:video\/)?(\d{5,})/.exec(u))) { medium = 'vimeo'; vid = m[1]; }
  }
  if (!vid) return null;
  if (medium === 'vimeo') return { medium, src: `https://player.vimeo.com/video/${encodeURIComponent(vid)}?autoplay=1&playsinline=1&dnt=1&title=0&byline=0&portrait=0` };
  if (medium === 'youtube') return { medium, src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(vid)}?autoplay=1&playsinline=1&rel=0&modestbranding=1` };
  return null;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
