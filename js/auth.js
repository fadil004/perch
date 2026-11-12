// Google OAuth 2.0 implicit flow with a full-page redirect.
// Popups break inside iOS home-screen apps; a redirect works everywhere.
// Tokens last an hour and there is no refresh token. They are renewed with a silent (prompt=none)
// request that names the account (login_hint): on a phone signed in to several Google accounts,
// prompt=none without a hint asks the user to pick one instead of renewing.
// The silent request first runs in a hidden frame (the app stays on screen; Google answers in about a
// second). Where the frame can't see the Google session (third-party cookies blocked, e.g. iOS), it
// falls back to the full-page redirect.
import { GOOGLE_CLIENT_ID } from '../config.js';
import { lsGet, lsSet } from './util.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const AUTH_KEY = 'perch.auth';
// localStorage (not sessionStorage): in iOS home-screen mode Google may return in another browsing context.
const STATE_KEY = 'perch.oauth.state';
const SILENT_KEY = 'perch.oauth.silent';
const ACCOUNT_KEY = 'perch.account';      // email of the Drive account; outlives any single token
const NEEDS_USER_KEY = 'perch.oauth.needsUser'; // set when Google said a silent renew needs the user
const WRITE_KEY = 'perch.scope.write';    // the user allowed "save links to Eagle" (adds drive.file)
const FRAME_KEY = 'perch.oauth.frame';    // { failedAt } after a frame renew failed, { bad } when it can't work here
const FRAME_RETRY = 3 * 24 * 3600_000;    // try the frame again after 3 days
const STATE_TTL = 10 * 60_000;
const SILENT_GAP = 2 * 60_000;            // at most one silent attempt per 2 minutes (no redirect loops)
export const RENEW_AHEAD = 10 * 60_000;   // renew when less than this is left
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** Only files this app creates (the link inbox). Asked for the first time a link is saved, never before. */
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const scopes = (write = false) => (write || lsGet(WRITE_KEY) ? `${SCOPE} ${WRITE_SCOPE}` : SCOPE);
/** Remember "may write" only once Google has actually granted drive.file (never just because it was asked). */
function noteWriteScope(scope) {
  if (!scope) return;
  lsSet(WRITE_KEY, scope.split(/\s+/).includes(WRITE_SCOPE) ? true : null);
}
/** The current token may create files (the inbox). */
export const canWrite = (a = getAuth()) => !!(a && a.scope && a.scope.split(/\s+/).includes(WRITE_SCOPE));
/** Silent-renew errors that genuinely need the user: only these show the Reconnect pill. */
export const NEEDS_USER = new Set(['interaction_required', 'login_required', 'consent_required', 'account_selection_required']);

export const hasClientId = () => typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.trim().length > 0;

/** The app's own URL (directory form) — must be registered as an authorized redirect URI. */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export const getAuth = () => lsGet(AUTH_KEY);
export const tokenValid = (a = getAuth()) => !!(a && a.token && a.exp - 60_000 > Date.now());
export const token = () => getAuth()?.token || null;
/** Milliseconds until the token expires (negative when expired, -Infinity without one). */
export const tokenLeft = (a = getAuth()) => (a && a.token ? a.exp - Date.now() : -Infinity);
export const accountHint = () => getAuth()?.email || lsGet(ACCOUNT_KEY) || '';

export function rememberAccount(email) {
  if (!email) return;
  lsSet(ACCOUNT_KEY, email);
  const a = getAuth();
  if (a && a.email !== email) lsSet(AUTH_KEY, { ...a, email });
}

function randomState() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function authUrl({ state, silent, write = false }) {
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID.trim(),
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: scopes(write),
    include_granted_scopes: 'true',
    state,
  });
  const hint = accountHint();
  if (hint) p.set('login_hint', hint);
  if (silent) p.set('prompt', 'none');
  return `${AUTH_URL}?${p}`;
}

/**
 * Navigate to Google. silent=true asks for a fresh token without UI (works once consent exists).
 * write=true also asks to create files (drive.file), for saving links to the Eagle inbox.
 */
export function signIn({ silent = false, write = false } = {}) {
  // WRITE_KEY is only set on the way back, once Google says drive.file was granted (see consumeRedirect).
  const state = randomState();
  lsSet(STATE_KEY, { state, silent, write, t: Date.now() });
  if (silent) lsSet(SILENT_KEY, Date.now());
  location.assign(authUrl({ state, silent, write }));
}

/** The hidden-frame renew may work here: signed in before, nothing pending from the user, not known to fail. */
export function frameRenewAllowed() {
  if (!hasClientId() || !navigator.onLine || !(getAuth() || accountHint())) return false;
  if (lsGet(NEEDS_USER_KEY)) return false;
  const f = lsGet(FRAME_KEY);
  return !(f && f.bad && Date.now() - f.bad < FRAME_RETRY);
}

let framePending = null;
/**
 * Silent renew in a hidden frame: Google redirects the frame back to this app with the token in the
 * hash, the frame's page posts it here (see index.html) and the app never leaves the screen.
 * Resolves { ok: true } with the new token stored, or { error }.
 */
export function renewInFrame({ timeout = 6000 } = {}) {
  if (framePending) return framePending;
  framePending = new Promise((resolve) => {
    const state = randomState();
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.tabIndex = -1;
    f.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
    let timer = 0;
    const done = (r) => {
      clearTimeout(timer);
      removeEventListener('message', onMessage);
      f.remove();
      framePending = null;
      // Only an explicit answer from Google counts as "the frame failed"; a slow load (timeout) proves nothing.
      if (!r.ok && r.error !== 'timeout') lsSet(FRAME_KEY, { failedAt: Date.now() });
      resolve(r);
    };
    function onMessage(e) {
      if (e.origin !== location.origin || e.source !== f.contentWindow) return;
      const hash = e.data && e.data.perchOAuth;
      if (typeof hash !== 'string') return;
      const p = new URLSearchParams(hash.replace(/^#/, ''));
      if (p.get('state') !== state) return;
      if (p.has('error') || !p.get('access_token')) { done({ error: p.get('error') || 'no_token' }); return; }
      const prev = getAuth();
      const auth = {
        token: p.get('access_token'),
        exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
        scope: p.get('scope') || scopes(),
      };
      if (prev && prev.email) auth.email = prev.email;   // login_hint pinned the same account
      noteWriteScope(p.get('scope'));
      lsSet(AUTH_KEY, auth);
      lsSet(NEEDS_USER_KEY, null);
      lsSet(FRAME_KEY, null);
      done({ ok: true, auth });
    }
    addEventListener('message', onMessage);
    timer = setTimeout(() => done({ error: 'timeout' }), timeout);
    f.src = authUrl({ state, silent: true });
    (document.body || document.documentElement).append(f);
  });
  return framePending;
}

/** Silent renew is possible: configured, online, signed in before, and no attempt in the last 2 minutes. */
export function canTrySilent() {
  if (!hasClientId() || !navigator.onLine || !(getAuth() || accountHint())) return false;
  if (lsGet(NEEDS_USER_KEY)) return false;   // it would only fail again: wait for the user to tap Reconnect
  const last = Number(lsGet(SILENT_KEY, 0)) || 0;
  return Date.now() - last > SILENT_GAP;
}

/** Handle #access_token / #error on return from Google. Returns null when there was nothing to handle. */
export function consumeRedirect() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!hash) return null;
  const p = new URLSearchParams(hash);
  if (!p.has('access_token') && !p.has('error')) return null;
  history.replaceState(null, '', location.pathname + location.search);
  // One-time use: read and delete. Reject a missing, mismatched or stale (>10 min) state.
  const saved = lsGet(STATE_KEY);
  lsSet(STATE_KEY, null);
  if (!saved || typeof saved.t !== 'number' || Date.now() - saved.t > STATE_TTL) return { error: 'state_expired' };
  if (saved.state !== p.get('state')) return { error: 'state_mismatch' };
  if (p.has('error')) {
    if (saved.silent && NEEDS_USER.has(p.get('error'))) lsSet(NEEDS_USER_KEY, true);
    return { error: p.get('error'), silent: !!saved.silent };
  }
  lsSet(NEEDS_USER_KEY, null);
  if (saved.silent) {
    // The frame failed moments ago but the page redirect worked: the frame can't see Google's session here.
    const f = lsGet(FRAME_KEY);
    if (f && f.failedAt && Date.now() - f.failedAt < 5 * 60_000) lsSet(FRAME_KEY, { bad: Date.now() });
  }
  noteWriteScope(p.get('scope'));
  const auth = {
    token: p.get('access_token'),
    exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
    scope: p.get('scope') || scopes(),
  };
  lsSet(AUTH_KEY, auth);   // the account email is filled in from Drive (about) right after
  return { ok: true, auth, silent: !!saved.silent };
}

export function expireToken() {
  const a = getAuth();
  if (a) lsSet(AUTH_KEY, { ...a, exp: 0 });
}

export function signOut() {
  const a = getAuth();
  lsSet(AUTH_KEY, null);
  lsSet(ACCOUNT_KEY, null);
  lsSet(NEEDS_USER_KEY, null);
  lsSet(WRITE_KEY, null);
  lsSet(FRAME_KEY, null);
  if (a?.token) {
    fetch(REVOKE_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(a.token)}`,
    }).catch(() => {});
  }
}
