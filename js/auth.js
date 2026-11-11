// Google OAuth 2.0 implicit flow with a full-page redirect.
// Popups break inside iOS home-screen apps; a redirect works everywhere.
// Tokens last an hour and there is no refresh token, so the app renews them with a silent
// (prompt=none) redirect that names the account (login_hint): on a phone signed in to several Google
// accounts, prompt=none without a hint asks the user to pick one instead of renewing.
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
const STATE_TTL = 10 * 60_000;
const SILENT_GAP = 2 * 60_000;            // at most one silent attempt per 2 minutes (no redirect loops)
export const RENEW_AHEAD = 10 * 60_000;   // renew when less than this is left
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
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

/** Navigate to Google. silent=true asks for a fresh token without UI (works once consent exists). */
export function signIn({ silent = false } = {}) {
  const state = randomState();
  lsSet(STATE_KEY, { state, silent, t: Date.now() });
  if (silent) lsSet(SILENT_KEY, Date.now());
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID.trim(),
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    state,
  });
  const hint = accountHint();
  if (hint) p.set('login_hint', hint);
  if (silent) p.set('prompt', 'none');
  location.assign(`${AUTH_URL}?${p}`);
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
  const auth = {
    token: p.get('access_token'),
    exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
    scope: p.get('scope') || SCOPE,
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
  if (a?.token) {
    fetch(REVOKE_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(a.token)}`,
    }).catch(() => {});
  }
}
