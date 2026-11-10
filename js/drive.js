// Thin Google Drive v3 client. The backend is injectable so demo mode can run the exact same code
// against an in-browser mock.
import { pool, sleep } from './util.js';

export const API = 'https://www.googleapis.com/drive/v3';
export const FOLDER = 'application/vnd.google-apps.folder';

export class AuthError extends Error {
  constructor() { super('Google sign-in expired'); this.name = 'AuthError'; }
}
export class DriveError extends Error {
  constructor(status, message) { super(message || `Drive error ${status}`); this.name = 'DriveError'; this.status = status; }
}

/** Real network backend. */
export function fetchBackend() {
  return ({ path, params, token, signal }) => fetch(`${API}/${path}?${new URLSearchParams(params)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal,
  });
}

export function createDrive({ backend, getToken = () => null, onAuthError = () => {}, concurrency = 8 } = {}) {
  const limit = pool(concurrency);
  const stats = { requests: 0, retries: 0 };

  function request(path, params = {}, { signal } = {}) {
    return limit(async () => {
      for (let attempt = 0; ; attempt++) {
        let res;
        try {
          stats.requests++;
          res = await backend({ path, params, token: getToken(), signal });
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (attempt < 2) { stats.retries++; await sleep(600 * (attempt + 1)); continue; }
          throw new DriveError(0, navigator.onLine ? 'Network error' : 'You are offline');
        }
        if (res.ok) return res;
        if (res.status === 401) { onAuthError(); throw new AuthError(); }
        let body = null;
        try { body = await res.clone().json(); } catch { /* not JSON */ }
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

  const media = (id) => request(`files/${encodeURIComponent(id)}`, { alt: 'media', supportsAllDrives: 'true' });

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
        const page = await (await request('files', params)).json();
        if (page.files) out.push(...page.files);
        pageToken = page.nextPageToken || '';
      } while (pageToken);
      return out;
    },
    async get(id, fields = 'id,name,mimeType,parents,modifiedTime') {
      return (await request(`files/${encodeURIComponent(id)}`, { fields, supportsAllDrives: 'true' })).json();
    },
    async json(id) {
      const text = await (await media(id)).text();
      return JSON.parse(text.replace(/^﻿/, ''));
    },
    async blob(id) {
      return (await media(id)).blob();
    },
    /** Raw media Response (for progress-tracked downloads). */
    raw: (id) => media(id),
  };
}
