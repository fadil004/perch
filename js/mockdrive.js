// In-browser stand-in for the slice of Google Drive v3 that Perch uses.
// It answers files.list (with the real q grammar), files.get and alt=media from a static manifest
// (tools/make_mock_manifest.py), so demo mode exercises the same sync code as production.
import { FOLDER } from './drive.js';
import { sleep } from './util.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const fail = (status, message) => json({ error: { code: status, message, errors: [{ reason: status === 400 ? 'invalid' : 'notFound', message }] } }, status);

// ── q grammar ────────────────────────────────────────────────────────────────
function tokenize(q) {
  const out = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      let s = '';
      i++;
      while (i < q.length && q[i] !== "'") {
        if (q[i] === '\\' && i + 1 < q.length) { s += q[i + 1]; i += 2; } else s += q[i++];
      }
      if (q[i] !== "'") throw new Error('unterminated string');
      i++;
      out.push({ t: 'str', v: s });
      continue;
    }
    if (c === '(' || c === ')') { out.push({ t: c }); i++; continue; }
    if (c === '!' && q[i + 1] === '=') { out.push({ t: 'op', v: '!=' }); i += 2; continue; }
    if (c === '=') { out.push({ t: 'op', v: '=' }); i++; continue; }
    const m = /^[A-Za-z_][\w.]*/.exec(q.slice(i));
    if (!m) throw new Error(`unexpected "${c}"`);
    const w = m[0], lw = w.toLowerCase();
    i += w.length;
    if (lw === 'and' || lw === 'or' || lw === 'not') out.push({ t: lw });
    else if (lw === 'contains' || lw === 'in') out.push({ t: 'op', v: lw });
    else if (lw === 'true' || lw === 'false') out.push({ t: 'bool', v: lw === 'true' });
    else out.push({ t: 'id', v: w });
  }
  return out;
}

export function parseQuery(q) {
  const toks = tokenize(q);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => { const k = toks[p]; if (!k || k.t !== t) throw new Error(`expected ${t}`); p++; return k; };
  const expr = () => { let l = term(); while (peek()?.t === 'or') { p++; l = { or: [l, term()] }; } return l; };
  const term = () => { let l = factor(); while (peek()?.t === 'and') { p++; l = { and: [l, factor()] }; } return l; };
  const factor = () => {
    const k = peek();
    if (!k) throw new Error('unexpected end of query');
    if (k.t === 'not') { p++; return { not: factor() }; }
    if (k.t === '(') { p++; const e = expr(); eat(')'); return e; }
    if (k.t === 'str') {
      p++;
      const op = eat('op');
      if (op.v !== 'in') throw new Error('expected "in"');
      return { inField: eat('id').v, value: k.v };
    }
    if (k.t === 'id') {
      p++;
      const op = eat('op');
      const val = toks[p++];
      if (!val || (val.t !== 'str' && val.t !== 'bool')) throw new Error('bad value');
      return { field: k.v, op: op.v, value: val.v };
    }
    throw new Error(`unexpected ${k.t}`);
  };
  if (!toks.length) return null;
  const tree = expr();
  if (p !== toks.length) throw new Error('trailing input');
  return tree;
}

function matches(n, f) {
  if (!n) return true;
  if (n.or) return matches(n.or[0], f) || matches(n.or[1], f);
  if (n.and) return matches(n.and[0], f) && matches(n.and[1], f);
  if (n.not) return !matches(n.not, f);
  if (n.inField) return n.inField === 'parents' && (f.parents || []).includes(n.value);
  const v = n.field === 'trashed' ? !!f.trashed : f[n.field];
  if (n.op === '=') return v === n.value;
  if (n.op === '!=') return v !== n.value;
  if (n.op === 'contains') return typeof v === 'string' && v.toLowerCase().includes(String(n.value).toLowerCase());
  return false;
}

const countParents = (n) => !n ? 0 : n.or ? countParents(n.or[0]) + countParents(n.or[1]) : n.and ? countParents(n.and[0]) + countParents(n.and[1]) : n.not ? countParents(n.not) : n.inField ? 1 : 0;

/** Parent ids a result must have, or null when the query doesn't constrain parents (for indexing). */
function parentScope(n) {
  if (!n) return null;
  if (n.inField === 'parents') return [n.value];
  if (n.or) { const a = parentScope(n.or[0]), b = parentScope(n.or[1]); return a && b ? a.concat(b) : null; }
  if (n.and) return parentScope(n.and[0]) || parentScope(n.and[1]);
  return null;
}

// ── mock ─────────────────────────────────────────────────────────────────────
export const MOCK_CACHE = 'perch-mock';
export async function createMockDrive(manifestUrl, { latency = 140, scale = 0, mutate = false, maxParents = 30 } = {}) {
  const base = new URL(manifestUrl, location.href);
  const res = await fetch(base, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Demo manifest not found (${res.status})`);
  const manifest = await res.json();

  const files = new Map();
  const kids = new Map();
  const add = (f) => {
    files.set(f.id, f);
    for (const p of f.parents || []) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(f); }
  };
  const remove = (id) => {
    const f = files.get(id);
    if (!f) return;
    files.delete(id);
    for (const p of f.parents || []) kids.set(p, (kids.get(p) || []).filter((x) => x.id !== id));
    for (const c of kids.get(id) || []) remove(c.id);
  };
  for (const f of manifest.files) add({ ...f, trashed: false, url: f.url ? new URL(f.url, base).href : null });

  const children = (id) => kids.get(id) || [];
  const libraries = [...files.values()].filter((f) => f.mimeType === FOLDER && /\.library$/i.test(f.name));
  const piece = (libId, name, folder = false) => children(libId).find((f) => f.name === name && (f.mimeType === FOLDER) === folder);

  // Virtual JSON overrides (cloned items, mutated items, rewritten mtime.json)
  const patches = new Map(); // fileId -> async () => object

  if (scale > 0) {
    let serial = 0;
    for (const lib of libraries) {
      const images = piece(lib.id, 'images', true);
      const mtimeFile = piece(lib.id, 'mtime.json');
      if (!images || !mtimeFile) continue;
      const real = children(images.id).filter((f) => f.mimeType === FOLDER && f.name.endsWith('.info') && children(f.id).some((c) => c.name === 'metadata.json'));
      if (!real.length) continue;
      const extra = {};
      for (let n = real.length, k = 0; n < scale; n++, k++) {
        const src = real[k % real.length];
        const itemId = `Z${(serial++).toString(36).toUpperCase().padStart(12, '0')}`;
        const folderId = `clone-${lib.id.slice(0, 6)}-${itemId}`;
        add({ id: folderId, name: `${itemId}.info`, mimeType: FOLDER, parents: [images.id], modifiedTime: src.modifiedTime, trashed: false });
        const shift = (k + 1) * 3_600_000;
        children(src.id).forEach((c, ci) => {
          const id = `${folderId}-${ci}`;
          add({ ...c, id, parents: [folderId] });
          if (c.name === 'metadata.json') {
            patches.set(id, async () => {
              const j = await (await fetch(c.url)).json();
              return { ...j, id: itemId, btime: (j.btime || 0) - shift, mtime: (j.mtime || 0) - shift };
            });
          }
        });
        extra[itemId] = 1_700_000_000_000 + n;
      }
      const prev = patches.get(mtimeFile.id);
      patches.set(mtimeFile.id, async () => {
        const base0 = prev ? await prev() : await (await fetch(mtimeFile.url)).json();
        const merged = { ...base0, ...extra };
        merged.all = Object.keys(merged).filter((k) => k !== 'all').length;
        return merged;
      });
    }
  }

  // ?mutate=1 — simulate edits made in Eagle desktop since the last sync: 2 edited items, 1 removed item.
  if (mutate) {
    for (const lib of libraries) {
      const images = piece(lib.id, 'images', true);
      const mtimeFile = piece(lib.id, 'mtime.json');
      if (!images || !mtimeFile) continue;
      const infos = children(images.id).filter((f) => f.mimeType === FOLDER && children(f.id).some((c) => c.name === 'metadata.json'));
      const edited = infos.slice(0, 2), gone = infos[2];
      const editedIds = edited.map((f) => f.name.replace(/\.info$/, ''));
      for (const f of edited) {
        const meta = children(f.id).find((c) => c.name === 'metadata.json');
        const prev = patches.get(meta.id);
        patches.set(meta.id, async () => {
          const j = prev ? await prev() : await (await fetch(meta.url)).json();
          return { ...j, mtime: Date.now(), tags: [...new Set([...(j.tags || []), 'edited'])] };
        });
      }
      const goneId = gone ? gone.name.replace(/\.info$/, '') : null;
      if (gone) remove(gone.id);
      const prevM = patches.get(mtimeFile.id);
      patches.set(mtimeFile.id, async () => {
        const m = prevM ? await prevM() : await (await fetch(mtimeFile.url)).json();
        const out = { ...m };
        for (const id of editedIds) out[id] = Date.now();
        if (goneId) delete out[goneId];
        out.all = Object.keys(out).filter((k) => k !== 'all').length;
        return out;
      });
    }
  }

  const strip = (f) => {
    const { url, trashed, ...rest } = f;
    return rest;
  };

  let created = 0;
  const trashedIds = [];        // files moved to the bin (drive.trash), for tests
  const sessions = new Map();   // resumable uploads in progress: session URL -> { meta, size, got, parts }
  const bytes = new Map();      // uploaded file id -> () => Promise<Blob>

  // What Perch creates (the inbox, its requests and uploaded videos) is kept in the Cache API like a real
  // Drive would keep it, so demo mode survives a reload. Reset by clearing site data or leaving the demo.
  const keep = new URL(`__mock/`, document.baseURI).href;
  const store = () => caches.open(MOCK_CACHE);
  const save = (f, body = '') => store().then((c) => c.put(keep + encodeURIComponent(f.id), new Response(body, {
    headers: { 'x-meta': encodeURIComponent(JSON.stringify(strip(f))), 'content-type': body instanceof Blob ? (body.type || 'application/octet-stream') : 'application/json' },
  }))).catch(() => {});
  const forget = (id) => store().then((c) => c.delete(keep + encodeURIComponent(id))).catch(() => {});
  try {
    const c = await store();
    for (const req of await c.keys()) {
      const res = await c.match(req);
      if (!res) continue;
      const f = { ...JSON.parse(decodeURIComponent(res.headers.get('x-meta') || '%7B%7D')), trashed: false };
      if (!f.id) continue;
      add(f);
      if (f.mimeType === FOLDER) continue;
      if ((res.headers.get('content-type') || '').startsWith('application/json')) { const text = await res.text(); patches.set(f.id, async () => JSON.parse(text)); }
      else bytes.set(f.id, async () => (await c.match(req)).blob());
    }
  } catch { /* no Cache API: the demo inbox lasts for the session only */ }
  async function backend({ path, params, method = 'GET', meta, content, size }) {
    await sleep(latency * (0.6 + Math.random() * 0.8));
    if (method === 'POST' && path === 'files' && meta && params.uploadType === 'resumable') {
      const missing = (meta.parents || []).find((pid) => pid !== 'root' && !files.has(pid));
      if (missing) return fail(404, `File not found: ${missing}.`);
      const url = `${location.origin}/__mock-upload/${++created}`;
      sessions.set(url, { meta, size: Number(size) || 0, got: 0 });
      return new Response('', { status: 200, headers: { Location: url } });
    }
    if (method === 'POST' && path === 'files' && meta) {
      // files.create: folders and small uploads (the link inbox) live in memory for the session.
      const missing = (meta.parents || []).find((pid) => pid !== 'root' && !files.has(pid));
      if (missing) return fail(404, `File not found: ${missing}.`);
      const now = new Date().toISOString();
      const f = { id: `new-${++created}-${Date.now().toString(36)}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || ['root'], createdTime: now, modifiedTime: now, trashed: false };
      add(f);
      if (content != null) { const text = String(content); patches.set(f.id, async () => JSON.parse(text)); }
      save(f, content != null ? String(content) : '');
      return json(strip(f));
    }
    if (path === 'files') {
      let tree;
      try { tree = parseQuery(params.q || ''); } catch (e) { return fail(400, `Invalid Value: ${e.message}`); }
      if (countParents(tree) > maxParents) return fail(400, 'The query is too complex.');
      const scope = parentScope(tree);
      const pool = scope ? [...new Set(scope)].flatMap(children) : [...files.values()];
      const hits = pool.filter((f) => matches(tree, f));
      const size = Math.min(Number(params.pageSize) || 100, 1000);
      const start = Number(params.pageToken || 0);
      const page = hits.slice(start, start + size).map(strip);
      return json(start + size < hits.length ? { files: page, nextPageToken: String(start + size) } : { files: page });
    }
    const m = /^files\/(.+)$/.exec(path);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const f = files.get(id);
      if (!f) return fail(404, `File not found: ${id}`);
      if (method === 'PATCH' && meta && meta.trashed) {
        // files.update { trashed: true }: gone from every listing (and from the kept demo inbox).
        trashedIds.push(id);
        remove(id); bytes.delete(id); patches.delete(id); await forget(id);
        return json({ id });
      }
      if (params.alt === 'media') {
        if (patches.has(id)) return json(await patches.get(id)());
        if (bytes.has(id)) { const b = await bytes.get(id)(); return new Response(b, { headers: { 'content-type': b.type || 'application/octet-stream', 'content-length': String(b.size) } }); }
        if (!f.url) return fail(404, 'No content');
        return fetch(f.url);
      }
      return json(strip(f));
    }
    return fail(404, 'Unknown endpoint');
  }

  /** Upload bytes to a resumable session (stands in for the XHR PUT). Sends in slices so progress moves. */
  backend.put = async ({ url, headers, body, onProgress }) => {
    const res = (status, extra = {}, text = '') => ({ status, header: (n) => extra[n] ?? null, text });
    const s = sessions.get(url);
    if (!s) return res(404);
    const range = headers['Content-Range'] || '';
    if (/^bytes \*\//.test(range)) return s.file ? res(200, {}, JSON.stringify(s.file)) : res(308, s.got ? { Range: `bytes=0-${s.got - 1}` } : {});
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m || Number(m[1]) !== s.got) return res(400);
    const n = body ? body.size : 0;
    if (body) (s.parts ||= []).push(body);
    for (let sent = 0; sent < n; ) {
      await sleep(40);
      sent = Math.min(n, sent + Math.max(256 * 1024, n / 12));
      onProgress && onProgress(sent);
    }
    s.got += n;
    if (s.got < Number(m[3])) return res(308, { Range: `bytes=0-${s.got - 1}` });
    const now = new Date().toISOString();
    const f = { id: `new-${++created}-${Date.now().toString(36)}`, name: s.meta.name, mimeType: s.meta.mimeType, parents: s.meta.parents || ['root'], size: String(s.got), createdTime: now, modifiedTime: now, trashed: false };
    add(f);
    const blob = new Blob(s.parts || [], { type: s.meta.mimeType || '' });
    bytes.set(f.id, async () => blob);
    save(f, blob);
    s.file = strip(f);
    return res(200, {}, JSON.stringify(s.file));
  };

  /** Stand in for Video Grabber on the computer: write back into a request (e.g. { status: 'done' }). */
  async function writeBack(id, patch) {
    const f = files.get(id);
    if (!f || !patches.has(id)) throw new Error(`No request ${id}`);
    const body = { ...(await patches.get(id)()), ...patch };
    const text = JSON.stringify(body, null, 2);
    patches.set(id, async () => JSON.parse(text));
    f.modifiedTime = new Date().toISOString();
    await save(f, text);
  }
  /** …and delete a file (the plugin removes the inbox video once Eagle has it). */
  async function removeFile(id) { remove(id); bytes.delete(id); await forget(id); }

  /** fileId -> absolute URL, for the service worker's ./media/<id> route. */
  function mediaMap() {
    const out = {};
    for (const f of files.values()) if (f.url && f.mimeType !== FOLDER && f.name !== 'metadata.json') out[f.id] = f.url;
    return out;
  }

  return { backend, mediaMap, fileCount: () => files.size, hasBytes: (id) => bytes.has(id), writeBack, removeFile, trashed: () => [...trashedIds] };
}
