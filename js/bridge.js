// Phone downloader ("bridge"): yt-dlp running in Termux on this phone, behind a small HTTP API on
// 127.0.0.1:47821 (contract: bridge/API.md). A web page can't download from Instagram or TikTok itself,
// so Perch asks the bridge to, copies the finished file into the page and uploads it like any other
// video from the phone. Login cookies never leave the phone: the user adds a cookies.txt here. Everything here fails soft: a bridge that is off, blocked or unpaired just means
// the link goes to the computer as before.
import { lsGet, lsSet } from './util.js';

export const BRIDGE = 'http://127.0.0.1:47821';
const KEY = 'perch.bridge';             // { token } — handed over once by the installer (#bridge=<token>)
const JOBS_KEY = 'perch.bridge.jobs';   // downloads still running in the bridge: [{ id, url, t, lib }]
const DEV_KEY = 'perch.bridge.dev';     // another bridge address, honoured on dev hosts only (tests)
const JOB_TTL = 24 * 60 * 60_000;       // the bridge drops unclaimed jobs after a day
const DEV = /(^|\.)localhost$|^127\.0\.0\.1$|^\[::1\]$/.test(location.hostname);

export class BridgeError extends Error {
  constructor(code, message, status = 0) { super(message || code); this.name = 'BridgeError'; this.code = code; this.status = status; }
}

const base = () => (DEV && lsGet(DEV_KEY)) || BRIDGE;
const token = () => lsGet(KEY)?.token || '';
export const paired = () => !!token();

/**
 * The installer opens Perch at #bridge=<token>. Keep the token and take it out of the address (so it never
 * lands in history or a shared link). Returns true when a token was taken.
 */
export function takePairing() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!hash.includes('bridge=')) return false;
  const p = new URLSearchParams(hash);
  const tok = (p.get('bridge') || '').trim();
  p.delete('bridge');
  const rest = p.toString();
  history.replaceState(null, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
  if (!/^[\w.~-]{8,256}$/.test(tok)) return false;
  lsSet(KEY, { token: tok });
  return true;
}

/** One request to the bridge. Network trouble (off, blocked by the browser, timed out) is code 'off'. */
async function call(method, path, { body, timeout = 8000, signal, headers = {} } = {}) {
  if (!paired()) throw new BridgeError('unpaired', 'Phone downloader not set up');
  const ctl = new AbortController();
  const timer = timeout ? setTimeout(() => ctl.abort(), timeout) : 0;
  if (signal) signal.addEventListener('abort', () => ctl.abort(), { once: true });
  let res;
  try {
    res = await fetch(base() + path, {
      method,
      headers: { 'X-Perch-Token': token(), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal && signal.aborted) throw e;
    throw new BridgeError('off', 'Phone downloader is off');
  }
  clearTimeout(timer);
  if (res.ok) return res;
  let j = null;
  try { j = await res.json(); } catch { /* not JSON */ }
  throw new BridgeError(j?.code || (res.status === 401 ? 'auth' : res.status === 403 ? 'origin' : res.status === 404 ? 'notfound' : 'bad'), j?.error || `Phone downloader error ${res.status}`, res.status);
}
const json = async (...a) => (await call(...a)).json();

let problem = '';
/** Why the last ping failed: 'unpaired' | 'off' | 'auth' (token not accepted) | 'origin' | '' (it answered). */
export const pingProblem = () => problem;

/** The bridge's status JSON, or null when it isn't set up, is off, or the browser blocked it. Never throws. */
export async function ping({ timeout = 1500 } = {}) {
  if (!paired()) { problem = 'unpaired'; return null; }
  try {
    const info = await json('GET', '/ping', { timeout });
    if (!info || info.app !== 'perch-bridge') { problem = 'off'; return null; }
    problem = '';
    return info;
  } catch (e) {
    problem = e.code === 'auth' || e.code === 'origin' ? e.code : 'off';
    return null;
  }
}

export const startDownload = (url) => json('POST', '/download', { body: { url } });
export const getJob = (id) => json('GET', `/job/${encodeURIComponent(id)}`, { timeout: 5000 });
export const finishJob = (id) => json('DELETE', `/job/${encodeURIComponent(id)}`, { timeout: 5000 });
export const pushCookies = (text, source, sourceTime = '') => json('POST', '/cookies', { body: { text, source, sourceTime } });
export const clearCookies = () => json('DELETE', '/cookies');

/** filename*=UTF-8''… (or filename="…") from Content-Disposition. */
function nameFrom(cd) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd || '');
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* malformed */ } }
  const plain = /filename="?([^";]+)"?/i.exec(cd || '');
  return plain ? plain[1].trim() : '';
}

/**
 * Copy a finished file from the bridge straight into the phone's storage, with progress (got, total). The bytes
 * stream through `keep(body, { name, type, size })` (which stores them and resolves with what it kept) and are
 * never held in memory, so a large video can't take the page down. A connection cut part-way starts the copy
 * again (it's loopback, so that's quick), twice at most. `meta` ({ name, size, type }) from the job fills in
 * what the headers don't say. Resolves with keep's result plus { name, type, size }.
 */
export async function fetchFile(id, n, onProgress = () => {}, meta = {}, keep) {
  for (let attempt = 0; ; attempt++) {
    let got = 0;
    try {
      const res = await call('GET', `/file/${encodeURIComponent(id)}/${n}`, { timeout: 0 });
      const total = Number(meta.size) || Number(res.headers.get('content-length')) || 0;
      const type = meta.type || (res.headers.get('content-type') || '').split(';')[0] || 'video/mp4';
      const name = meta.name || nameFrom(res.headers.get('content-disposition')) || `video-${n}.mp4`;
      const body = res.body || (await res.blob()).stream();
      const count = new TransformStream({
        transform(chunk, ctl) { got += chunk.byteLength; onProgress(got, total); ctl.enqueue(chunk); },
        // Short: fail the stream, so nothing half-copied is kept.
        flush() { if (total && got < total) throw new BridgeError('off', 'The file was cut off'); },
      });
      const kept = await keep(body.pipeThrough(count), { name, type, size: total });
      onProgress(total || got, total || got);
      return { ...kept, name, type, size: total || got };
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') throw e;                          // the phone is full: retrying won't help
      if (e && e.name === 'BridgeError' && e.code !== 'off') throw e;            // auth, notfound…
      if (attempt >= 2) throw new BridgeError('copy', 'Couldn’t copy the video from the phone downloader');
    }
  }
}

// ── downloads still running in the bridge (so a reopened sheet, or the next launch, picks them up) ──
export function activeJobs() {
  const now = Date.now();
  return lsGet(JOBS_KEY, []).filter((j) => j && j.id && now - j.t < JOB_TTL);
}
export function rememberJob(id, url, lib = '') {
  lsSet(JOBS_KEY, [...activeJobs().filter((j) => j.id !== id), { id, url, t: Date.now(), lib }]);
}
export function forgetJob(id) {
  const rest = activeJobs().filter((j) => j.id !== id);
  lsSet(JOBS_KEY, rest.length ? rest : null);
}

// ── cookies (only ever from this phone: a cookies.txt the user picks) ──────────────────────────────────
const SITE_NAMES = {
  'instagram.com': 'Instagram', 'x.com': 'X', 'twitter.com': 'X', 'tiktok.com': 'TikTok', 'youtube.com': 'YouTube',
  'facebook.com': 'Facebook', 'vimeo.com': 'Vimeo', 'pinterest.com': 'Pinterest', 'reddit.com': 'Reddit', 'threads.net': 'Threads',
};
/** "Instagram, X, TikTok…" for the cookie line. */
export function siteNames(sites = [], max = 3) {
  const bare = (s) => String(s).replace(/^\.?(www\.)?/, '');
  const names = [...new Set(sites.map((s) => SITE_NAMES[bare(s)] || bare(s)))];
  return names.slice(0, max).join(', ') + (names.length > max ? '…' : '');
}
