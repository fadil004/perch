// Thin Google Drive v3 client. The backend is injectable so demo mode can run the exact same code
// against an in-browser mock.
import { pool, sleep } from './util.js';

export const API = 'https://www.googleapis.com/drive/v3';
export const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';
const API_TIMEOUT = 45_000;     // an API call (list, metadata, small JSON) that hangs this long is a network error
const STALL_TIMEOUT = 45_000;   // an upload PUT with no progress for this long is a network error

export class AuthError extends Error {
  constructor() { super('Google sign-in expired'); this.name = 'AuthError'; }
}
export class DriveError extends Error {
  constructor(status, message) { super(message || `Drive error ${status}`); this.name = 'DriveError'; this.status = status; }
}

/** Real network backend. GET by default; `upload` targets the upload endpoint (multipart creates). */
export function fetchBackend() {
  return ({ path, params, token, signal, method = 'GET', body, headers = {}, upload = false }) =>
    fetch(`${upload ? UPLOAD_API : API}/${path}?${new URLSearchParams(params)}`, {
      method,
      headers: token ? { ...headers, Authorization: `Bearer ${token}` } : headers,
      body,
      signal,
    });
}

/**
 * PUT with upload progress (fetch can't report it). Resolves with { status, header(name), text }.
 * No progress for STALL_TIMEOUT: aborted and reported as a network error, so the caller probes and resumes.
 */
function xhrPut({ url, headers = {}, body = null, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    let stalled = false, timer = 0;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; x.abort(); }, STALL_TIMEOUT); };
    x.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => { arm(); if (onProgress) onProgress(e.loaded); };
    x.onprogress = arm;
    x.onload = () => { clearTimeout(timer); resolve({ status: x.status, header: (n) => x.getResponseHeader(n), text: x.responseText }); };
    x.onerror = x.ontimeout = () => { clearTimeout(timer); reject(new TypeError('Network error')); };
    x.onabort = () => { clearTimeout(timer); reject(stalled ? new TypeError('Upload stalled') : new DOMException('Upload stopped', 'AbortError')); };
    if (signal) {
      if (signal.aborted) { reject(new DOMException('Upload stopped', 'AbortError')); return; }
      signal.addEventListener('abort', () => x.abort(), { once: true });
    }
    arm();
    x.send(body);
  });
}

/** The caller's signal plus a timeout (0: none). `timedOut()` tells a timeout from the caller's abort. */
function withTimeout(signal, ms) {
  if (!ms) return { signal, timedOut: () => false };
  const ctl = new AbortController();
  let fired = false;
  const timer = setTimeout(() => { fired = true; ctl.abort(new DOMException('Timed out', 'TimeoutError')); }, ms);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener('abort', () => { clearTimeout(timer); ctl.abort(signal.reason); }, { once: true });
  }
  return { signal: ctl.signal, timedOut: () => fired, done: () => clearTimeout(timer) };
}

/**
 * onAuthError(tokenUsed) is called on a 401 and may return (a promise of) true once a fresh token is in
 * place: the request is then sent once more, so a token that expired mid-use heals without a hiccup.
 */
export function createDrive({ backend, getToken = () => null, onAuthError = () => false, concurrency = 8 } = {}) {
  const limit = pool(concurrency);
  const stats = { requests: 0, retries: 0 };

  /**
   * `timeout` (ms, 0 = none) covers the call and reading its body; a call that hangs becomes a network error.
   * `retryNet: false` for creates: Drive may have made the file before the connection dropped, so never send it twice.
   */
  function request(path, params = {}, { signal, timeout = API_TIMEOUT, retryNet = true, ...extra } = {}) {
    return limit(async () => {
      let healed = false;
      for (let attempt = 0; ; attempt++) {
        let res;
        const tok = getToken();
        const t = withTimeout(signal, timeout);
        try {
          stats.requests++;
          res = await backend({ path, params, token: tok, signal: t.signal, ...extra });
        } catch (e) {
          if (e && (e.name === 'AbortError' || e.name === 'TimeoutError') && !t.timedOut()) throw e;
          if (retryNet && attempt < 2) { stats.retries++; await sleep(600 * (attempt + 1)); continue; }
          throw new DriveError(0, navigator.onLine ? 'Network error' : 'You are offline');
        }
        if (res.ok) return Object.assign(res, { timedOut: t.timedOut });
        if (res.status === 401) {
          if (!healed && (await onAuthError(tok))) { healed = true; continue; }
          throw new AuthError();
        }
        let body = null;
        try { body = await res.clone().json(); } catch { /* not JSON */ }
        if (t.done) t.done();
        const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
        const retryable = res.status === 429 || res.status >= 500 ||
          (res.status === 403 && /rate|quota|backendError/i.test(reason));
        if (retryable && attempt < 5) {
          stats.retries++;
          await sleep(Math.min(16000, 500 * 2 ** attempt) + Math.random() * 400);
          continue;
        }
        throw new DriveError(res.status, body?.error?.message);
      }
    });
  }

  const media = (id, opts) => request(`files/${encodeURIComponent(id)}`, { alt: 'media', supportsAllDrives: 'true' }, opts);
  /** Read a body; the request's timeout firing mid-read is a network error like any other. */
  const read = async (res, how) => {
    try { return await res[how](); } catch (e) {
      if (res.timedOut && res.timedOut()) throw new DriveError(0, navigator.onLine ? 'Network error' : 'You are offline');
      throw e;
    }
  };

  return {
    stats,
    /** files.list with auto-pagination. `fields` is the per-file field list. */
    async list(q, fields = 'id,name,mimeType,parents,size,modifiedTime', { pageSize = 1000 } = {}) {
      const out = [];
      let pageToken = '';
      do {
        const params = {
          q,
          fields: `nextPageToken,files(${fields})`,
          pageSize: String(pageSize),
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        };
        if (pageToken) params.pageToken = pageToken;
        const page = await read(await request('files', params), 'json');
        if (page.files) out.push(...page.files);
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    async get(id, fields = 'id,name,mimeType,parents,modifiedTime') {
      return read(await request(`files/${encodeURIComponent(id)}`, { fields, supportsAllDrives: 'true' }), 'json');
    },
    async json(id) {
      const text = await read(await media(id), 'text');
      return JSON.parse(text.replace(/^﻿/, ''));
    },
    async blob(id) {
      return read(await media(id), 'blob');
    },
    /** Raw media Response (for progress-tracked downloads; streaming, so no timeout). */
    raw: (id) => media(id, { timeout: 0 }),
    /** Create a folder (metadata only). */
    async createFolder(name, parents = [], fields = 'id,name') {
      const meta = { name, mimeType: FOLDER, ...(parents.length ? { parents } : {}) };
      return read(await request('files', { fields, supportsAllDrives: 'true' }, {
        method: 'POST', body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json' }, meta, retryNet: false,
      }), 'json');
    },
    /** Create a small file with content in one multipart upload. */
    async createFile(name, parents, content, { mimeType = 'application/json', fields = 'id,name,createdTime' } = {}) {
      const meta = { name, mimeType, ...(parents.length ? { parents } : {}) };
      const boundary = `perch${Math.random().toString(36).slice(2)}`;
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;
      return read(await request('files', { uploadType: 'multipart', fields, supportsAllDrives: 'true' }, {
        method: 'POST', upload: true, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, meta, content, retryNet: false,
      }), 'json');
    },
    /** Resumable upload, step 1: open an upload session. Resolves with its URL (Drive keeps it for a week). */
    async startUpload(name, parents, { mimeType = 'application/octet-stream', size } = {}) {
      const meta = { name, mimeType, ...(parents.length ? { parents } : {}) };
      const res = await request('files', { uploadType: 'resumable', fields: 'id,name,size', supportsAllDrives: 'true' }, {
        method: 'POST', upload: true, body: JSON.stringify(meta), meta, size,
        headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mimeType, ...(size != null ? { 'X-Upload-Content-Length': String(size) } : {}) },
      });
      const session = res.headers.get('Location');
      if (!session) throw new DriveError(0, 'The upload could not start');
      return session;
    },
    /**
     * Step 2: send the bytes. Picks up where Drive stopped (a session from an earlier visit may already hold
     * part of the file), retries dropped connections, and resolves with the created file.
     * A session Drive no longer knows rejects with DriveError status 410: start a new one.
     */
    async sendUpload(session, blob, { onProgress = () => {}, signal, fresh = false } = {}) {
      const total = blob.size;
      const put = backend.put || xhrPut;
      let healed = false;
      const send = async (range, body, base) => {
        const tok = getToken();
        const r = await put({ url: session, signal, body, headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), 'Content-Range': range },
          onProgress: (n) => onProgress(Math.min(total, base + n), total) });
        if (r.status === 401 && !healed && (await onAuthError(tok))) { healed = true; return send(range, body, base); }
        return r;
      };
      const finished = (r) => r.status === 200 || r.status === 201;
      const received = (r) => { const m = /bytes=0-(\d+)/.exec(r.header('Range') || ''); return m ? Number(m[1]) + 1 : 0; };
      const fail = (r) => {
        if (r.status === 401) throw new AuthError();
        if (r.status === 404 || r.status === 410 || r.status === 400) throw new DriveError(410, 'The upload expired');
        let msg = '';
        try { msg = JSON.parse(r.text).error.message; } catch { /* not JSON */ }
        throw new DriveError(r.status, msg || `Upload failed (${r.status})`);
      };
      let offset = 0;
      let resyncs = 0;
      let probe = !fresh;
      for (let attempt = 0; ; ) {
        try {
          if (probe) {
            const r = await send(`bytes */${total}`, null, 0);
            if (finished(r)) { onProgress(total, total); return JSON.parse(r.text); }
            if (r.status !== 308) fail(r);
            offset = received(r);
            probe = false;
          }
          onProgress(offset, total);
          const r = await send(`bytes ${offset}-${total - 1}/${total}`, blob.slice(offset), offset);
          if (finished(r)) { onProgress(total, total); return JSON.parse(r.text); }
          if (r.status === 308) { offset = received(r); attempt = 0; continue; }
          // The browser may quietly resend a cut-off PUT from its first byte; Drive refuses the overlap.
          // Ask Drive where it is and go on from there.
          if (r.status === 400 && resyncs++ < 3) { stats.retries++; probe = true; continue; }
          if (r.status !== 429 && r.status < 500) fail(r);
          throw new TypeError(`Upload interrupted (${r.status})`);
        } catch (e) {
          if (e.name === 'AbortError' || e.name === 'AuthError' || e.name === 'DriveError') throw e;
          // Dropped connection or a server hiccup: wait, ask Drive how much it has, carry on from there.
          if (++attempt > 6) throw new DriveError(0, navigator.onLine ? 'Network error' : 'You are offline');
          stats.retries++;
          await sleep(Math.min(20000, 1000 * 2 ** attempt));
          probe = true;
        }
      }
    },
    /** Move a file to Drive's bin (drive.file allows it for files this app created). */
    async trash(id) {
      const meta = { trashed: true };
      return read(await request(`files/${encodeURIComponent(id)}`, { fields: 'id', supportsAllDrives: 'true' }, {
        method: 'PATCH', body: JSON.stringify(meta), headers: { 'Content-Type': 'application/json' }, meta,
      }), 'json');
    },
    /** Email of the signed-in Drive account (used as login_hint when renewing the token). */
    async about() {
      const j = await read(await request('about', { fields: 'user(emailAddress)' }), 'json');
      return j?.user?.emailAddress || '';
    },
  };
}
