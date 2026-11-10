// Google OAuth 2.0 implicit flow with a full-page redirect.
// Popups break inside iOS home-screen apps; a redirect works everywhere.
import { GOOGLE_CLIENT_ID } from '../config.js';
import { lsGet, lsSet } from './util.js';

const AUTH_KEY = 'perch.auth';
// localStorage (not sessionStorage): in iOS home-screen mode Google may return in another browsing context.
const STATE_KEY = 'perch.oauth.state';
const SILENT_KEY = 'perch.oauth.silent';
const STATE_TTL = 10 * 60_000;
export const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export const hasClientId = () => typeof GOOGLE_CLIENT_ID === 'string' && GOOGLE_CLIENT_ID.trim().length > 0;

/** The app's own URL (directory form) — must be registered as an authorized redirect URI. */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export const getAuth = () => lsGet(AUTH_KEY);
export const tokenValid = (a = getAuth()) => !!(a && a.token && a.exp - 60_000 > Date.now());
export const token = () => getAuth()?.token || null;

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
  if (silent) p.set('prompt', 'none');
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
}

/** A silent attempt is allowed at most once every 10 minutes (prevents redirect loops). */
export function canTrySilent() {
  if (!hasClientId() || !navigator.onLine || !getAuth()) return false;
  const last = Number(lsGet(SILENT_KEY, 0)) || 0;
  return Date.now() - last > 10 * 60_000;
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
  if (p.has('error')) return { error: p.get('error'), silent: !!saved.silent };
  const auth = {
    token: p.get('access_token'),
    exp: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
    scope: p.get('scope') || SCOPE,
  };
  lsSet(AUTH_KEY, auth);
  return { ok: true, auth, silent: !!saved.silent };
}

export function expireToken() {
  const a = getAuth();
  if (a) lsSet(AUTH_KEY, { ...a, exp: 0 });
}

export function signOut() {
  const a = getAuth();
  lsSet(AUTH_KEY, null);
  if (a?.token) {
    fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(a.token)}`,
    }).catch(() => {});
  }
}
