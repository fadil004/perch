// Perch — boot, screens, sync orchestration, folders/search/more sheets.
import { $, h, clamp, debounce, lsGet, lsSet, timeAgo, fmtBytes, rubberband, reducedMotion, nextFrame } from './util.js';
import { I } from './icons.js';
import { kv, swkv, wipeAll } from './store.js';
import { hasClientId, signIn, consumeRedirect, tokenValid, token, getAuth, canTrySilent, expireToken, signOut, redirectUri, tokenLeft, rememberAccount, RENEW_AHEAD, NEEDS_USER, renewInFrame, frameRenewAllowed, canWrite } from './auth.js';
import { extractUrl, saveLink, recentLinks, siteOf } from './inbox.js';
import { createUploader, stash } from './uploads.js';
import { createDrive, fetchBackend } from './drive.js';
import { createMockDrive } from './mockdrive.js';
import { discoverLibraries, resolveFolderLink, syncLibrary, Library } from './eagle.js';
import { setThumbSource, prefetch, thumbIdOf } from './thumbs.js';
import { Grid } from './grid.js';
import { Viewer, FOLDER_COLORS } from './viewer.js';
import { openSheet, closeSheet, isSheetOpen } from './sheet.js';
import { layers } from './layers.js';
import { initInstall, canInstall, openInstallSheet, maybeShowInstallCard, hideInstallCard, onInstallChange } from './install.js';

const S = {
  mode: null,          // 'drive' | 'demo'
  modeKey: '',
  drive: null,
  mock: null,
  libs: [],
  lib: null,
  snap: null,
  model: null,
  view: { type: 'all' },
  unlocked: new Set(readUnlocked()),
  expanded: new Set(),
  search: { active: false, q: '', tags: [] },
  list: [],
  syncing: false,
  screen: '',
  authLost: false,
  swOk: false,
};
window.__perch = S; // handy for debugging in devtools
const SHARE_KEY = 'perch.share';     // a link shared to Perch, kept until it's saved (survives a sign-in redirect)
const SHARE_TTL = 60 * 60_000;
const SHARE_FILES_KEY = 'perch.share.files';   // videos just shared to Perch: show them uploading once the app is ready
let uploader = null;                           // see up()

const el = {
  onboard: $('#onboard'), libs: $('#libs'), syncing: $('#syncing'), main: $('#main'),
  wall: $('#wall'), libList: $('#lib-list'), libsSub: $('#libs-sub'),
  syncLib: $('#sync-lib'), syncBar: $('#sync-bar'), syncCount: $('#sync-count'),
  topbar: $('#topbar'), topbarTitle: $('#topbar-title'), ptr: $('#ptr'), ptrArc: $('#ptr-arc'),
  content: $('#content'), hero: $('#hero'), libName: $('#lib-name'), title: $('#title'), count: $('#count'),
  spin: $('#spin'), notice: $('#notice'), grid: $('#grid'), empty: $('#empty'),
  dock: $('#dock'), searchbar: $('#searchbar'), searchInput: $('#search-input'), searchClear: $('#search-clear'),
  searchTags: $('#search-tags'), suggest: $('#suggest'), toast: $('#toast'),
};

// ── static icons ─────────────────────────────────────────────────────────────
$('#mark').innerHTML = I.mark;
$('#lib-chev').innerHTML = I.chevronD;
$('#search-ico').innerHTML = I.search;
el.searchClear.innerHTML = I.x;
for (const b of el.dock.querySelectorAll('button')) b.innerHTML = I[b.dataset.act];
document.addEventListener('touchstart', () => {}, { passive: true }); // enables :active on iOS
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
initInstall({ toast: (...a) => toast(...a) });
const syncInstallEntry = () => {
  const show = canInstall();
  $('#btn-install').hidden = !show;
  $('#install-sep').hidden = !show;
};
syncInstallEntry();
onInstallChange(syncInstallEntry);
$('#btn-install').addEventListener('click', () => openInstallSheet());

// ── grid + viewer ────────────────────────────────────────────────────────────
const grid = new Grid(el.grid, { columns: lsGet('perch.cols', 2), onOpen: (i, tile) => openViewer(i, tile) });
grid.onColumns = (n, y) => setColumns(n, y);

const media = {
  async src(fileId, { size = 0, onProgress } = {}) {
    if (S.swOk && navigator.serviceWorker?.controller) return new URL(`media/${encodeURIComponent(fileId)}`, document.baseURI).href;
    // Fallback: download the whole file with progress, then play from memory.
    const res = await S.drive.raw(fileId);
    const total = Number(res.headers.get('content-length')) || size || 0;
    if (!res.body || !total || !onProgress) return URL.createObjectURL(await res.blob());
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(0.99, got / total));
    }
    onProgress(1);
    return URL.createObjectURL(new Blob(chunks, { type: res.headers.get('content-type') || '' }));
  },
  /**
   * Ask the service worker to keep a neighbouring video ready (whole file, small ones only), so swiping
   * to it starts at once. Skipped on Data Saver and very slow connections.
   */
  prefetch(fileId, size = 0) {
    if (!S.swOk || !navigator.serviceWorker?.controller || !fileId) return;
    if (size > 30 * 1024 * 1024) return;
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return;
    fetch(new URL(`media/${encodeURIComponent(fileId)}`, document.baseURI), { headers: { 'X-Perch-Prefetch': '1', 'X-Perch-Size': String(size || 0) } }).catch(() => {});
  },
  lastError: () => (S.mode === 'drive' && !tokenValid() ? { name: 'AuthError' } : null),
  /** A video failed: was it the token? Asks the service worker's media route for one byte. */
  async authFailed(fileId) {
    if (S.mode !== 'drive') return false;
    if (!tokenValid()) return true;
    if (!S.swOk) return false;
    try {
      const r = await fetch(new URL(`media/${encodeURIComponent(fileId)}`, document.baseURI), { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      return r.status === 401;
    } catch { return false; }
  },
  refreshing: () => !!S.redirecting,
};

const viewer = new Viewer({
  grid,
  media,
  getLibrary: () => S.model,
  toast,
  canOpenDrive: () => S.mode === 'drive',
  onTag: (t) => { viewer.close(); setTimeout(() => openSearch({ tags: [t] }), 60); },
  onFolder: (id) => { viewer.close(); setTimeout(() => selectView({ type: 'folder', id }), 60); },
  // A video hit a 401 mid-use: renew in the background and carry on ('renewed'), or redirect and come
  // back to the same frame ('redirect').
  onAuthNeeded: async (info) => {
    S.resumeVideo = info;
    if (S.mode !== 'drive') return false;
    expireToken();
    if (await renewQuiet('401')) { S.resumeVideo = null; return 'renewed'; }
    return renewNow('401') ? 'redirect' : false;
  },
  onReconnect: () => reconnect(),
  onClosed: () => { if (S.renewWhenIdle) { S.renewWhenIdle = false; renewSoon('idle'); } },
});

function openViewer(i, tile) {
  const rect = tile ? tile.getBoundingClientRect() : grid.tileRect(i);
  viewer.open(S.list, i, rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
}

// ── boot ─────────────────────────────────────────────────────────────────────
boot().catch((e) => { console.error(e); toast(e.message || 'Something went wrong'); });

async function boot() {
  const swReady = registerServiceWorker();
  const params = new URLSearchParams(location.search);
  takeSharedLink(params);
  const red = consumeRedirect();
  if (red && red.ok) {
    lsSet('perch.mode', { mode: 'drive' });
    S.authLost = false;
  } else if (red && (red.error === 'state_expired' || red.error === 'state_mismatch')) {
    setTimeout(() => toast('Sign-in timed out — please connect again'), 400);
  } else if (red && red.error && !red.silent) {
    setTimeout(() => toast(red.error === 'access_denied' ? 'Google access was not granted' : `Couldn’t connect (${red.error})`), 400);
  }

  let mode = lsGet('perch.mode');
  if (params.has('demo')) {
    const v = params.get('demo');
    mode = {
      mode: 'demo',
      manifest: !v || v === '1' ? 'demo/manifest.json' : v,
      scale: Number(params.get('scale')) || 0,
      mutate: params.get('mutate') === '1',
      latency: params.has('latency') ? Number(params.get('latency')) : 140,
    };
    lsSet('perch.mode', mode);
  }
  await swReady;
  if (!mode) return showOnboarding();
  if (mode.mode === 'demo') return startDemo(mode);
  return startDrive(red);
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => {
        navigator.serviceWorker.addEventListener('controllerchange', r, { once: true });
        setTimeout(r, 2500);
      });
    }
    if (navigator.serviceWorker.controller) {
      const res = await fetch(new URL('media/__ping', document.baseURI), { cache: 'no-store' });
      S.swOk = res.status === 204;
    }
  } catch (e) {
    console.warn('[perch] service worker unavailable:', e.message);
  }
}

async function startDemo(mode) {
  S.mode = 'demo';
  S.modeKey = `demo:${mode.manifest}:${mode.scale || 0}`;
  try {
    S.mock = await createMockDrive(mode.manifest, { scale: mode.scale, mutate: mode.mutate, latency: mode.latency });
  } catch (e) {
    // Offline with a cached demo library: still open it; sync will report that we're offline.
    const saved = lsGet(`perch.lib.${S.modeKey}`);
    const snap = saved ? await kv.get(snapKey(saved.id)).catch(() => null) : null;
    if (!snap) {
      lsSet('perch.mode', null);
      showOnboarding();
      toast(e.message);
      return;
    }
    S.mock = null;
  }
  S.drive = createDrive({ backend: S.mock ? S.mock.backend : () => Promise.reject(new TypeError('offline')) });
  if (!S.mock) { setThumbSource(S.drive); return afterConnect(); }
  await swkv.set('mode', { mode: 'demo' });
  await swkv.set('demo-map', S.mock.mediaMap());
  setThumbSource(S.drive);
  await afterConnect();
}

async function startDrive(red) {
  S.mode = 'drive';
  S.modeKey = 'drive';
  S.drive = createDrive({ backend: fetchBackend(), getToken: token, onAuthError: (tok) => onAuthExpired(tok) });
  await swkv.set('mode', { mode: 'drive' });
  setThumbSource(S.drive);
  // Expired or nearly: renew in the hidden frame first (about a second; the app never leaves the screen).
  // Only when that can't work does the page redirect below.
  if (!red && tokenLeft() <= RENEW_AHEAD) await renewQuiet('start', { timeout: 5000 });
  if (tokenValid()) {
    scheduleRenew();
    await swkv.set('auth', getAuth());
    // Close to expiry at launch: renew now rather than in the middle of a video (never right after a renew).
    if (!red && renewNow('start')) return;
    // Which account is this? Settled before anything cached is shown (and remembered for login_hint).
    await checkAccount(red);
    if (S.redirecting) return;
    if (tokenValid()) return afterConnect();
    // Google rejected the token during the check: carry on as for an expired one.
  }
  // Expired: a silent round trip to Google usually returns a fresh token instantly.
  if (!red && renewNow('start')) return;
  if (red && red.ok) await checkAccount(red);   // a token that arrived nearly expired: still never show another account's cache
  const saved = lsGet('perch.lib.drive');
  const snap = saved ? await kv.get(snapKey(saved.id)).catch(() => null) : null;
  if (saved && snap) {
    await openLibrary(saved);
    if (red && red.error && red.silent && !NEEDS_USER.has(red.error)) {
      // Google failed for another reason (not "needs the user"): offer a retry of the silent renew.
      setNotice('Couldn’t refresh sign-in · Retry', () => { saveUiState(); S.redirecting = true; signIn({ silent: true }); });
    } else onAuthLost();
    return;
  }
  showOnboarding();
}

/**
 * The token may belong to another Google account than the cached library (Reconnect, then a different
 * account picked on Google's page). Never show one account's cache to another: compare the account with
 * the one the cache was made with and wipe the cache when it differs or can't be confirmed.
 */
async function checkAccount(red) {
  const fresh = !!(red && red.ok);
  const prev = lsGet('perch.account');
  if (!fresh && prev && getAuth()?.email === prev) return;   // this token was checked when it arrived
  const saved = lsGet('perch.lib.drive');
  let email = '';
  try { email = await S.drive.about(); } catch { /* offline or rejected: decided below */ }
  let wipe = false;
  if (!email) wipe = fresh && !!(prev || saved);              // a new sign-in we can't identify: don't risk it
  else if (prev) wipe = prev !== email;
  else if (saved) wipe = !(await canRead(saved.id));          // cache from before accounts were remembered
  if (wipe) await forgetLibraries();
  if (email) rememberAccount(email);
}

async function canRead(folderId) {
  try { await S.drive.get(folderId, 'id'); return true; } catch { return false; }
}

/** Drop everything cached from the Drive account that was signed in before. */
async function forgetLibraries() {
  console.info('[perch] different Google account: clearing the cached library');
  try {
    for (const k of Object.keys(localStorage)) {
      if (k === 'perch.lib.drive' || k === RESUME_KEY || k.startsWith('perch.view.drive.') || k.startsWith('perch.pasted.drive')) localStorage.removeItem(k);
    }
  } catch { /* storage unavailable */ }
  try { sessionStorage.removeItem('perch.unlocked'); } catch { /* ignore */ }
  S.unlocked = new Set();
  S.libs = [];
  await wipeAll();                      // IndexedDB (libraries, thumbnails) and the service worker's store
  await swkv.set('mode', { mode: 'drive' });
  await swkv.set('auth', getAuth());
}

// ── token renewal ────────────────────────────────────────────────────────────
// Tokens last an hour. They are renewed in a hidden frame shortly before they expire, at launch, on
// resume and after a 401, so the app never leaves the screen. Where the frame can't work, a silent page
// redirect takes over, with the UI state saved first and restored after, so all the user sees is a flash.
const RESUME_KEY = 'perch.resume';
const RESUME_TTL = 10 * 60_000;

function videoPlaying() {
  const slot = viewer.isOpen && viewer.cur;
  const v = slot && slot.video;
  return !!(v && !v.paused && !v.ended && !v.error);   // an errored video keeps paused === false
}

let quietP = null;
/** Hidden-frame renew. Resolves true once a fresh token is in place (and handed to the service worker). */
function renewQuiet(reason, { timeout } = {}) {
  if (S.mode !== 'drive' || S.redirecting || !hasClientId() || !navigator.onLine) return Promise.resolve(false);
  if (quietP) return quietP;
  if (!frameRenewAllowed()) return Promise.resolve(false);
  quietP = renewInFrame({ timeout }).then(async (r) => {
    if (r.ok) {
      await swkv.set('auth', getAuth());
      S.authLost = false;
      if (S.screen === 'main' && /Reconnect|Refreshing|refresh sign-in/.test(el.notice.textContent || '')) setNotice(null);
      scheduleRenew();
      console.info(`[perch] token renewed in the background (${reason})`);
      return true;
    }
    console.info(`[perch] background renew failed (${reason}): ${r.error}`);
    return false;
  }).finally(() => { quietP = null; });
  return quietP;
}

/** Renew when it's due: quietly if possible, otherwise by the (well-timed) page redirect. */
async function renewSoon(reason) {
  if (S.mode !== 'drive' || S.redirecting || tokenLeft() > RENEW_AHEAD) return;
  if (await renewQuiet(reason)) return;
  renewNow(reason);
}

let renewTimer = 0;
/** Renew in the background a little before the token runs out, so it never expires mid-video. */
function scheduleRenew() {
  clearTimeout(renewTimer);
  if (S.mode !== 'drive' || !getAuth()) return;
  const wait = Math.max(5_000, tokenLeft() - RENEW_AHEAD + 1_000);
  renewTimer = setTimeout(() => { if (!document.hidden) renewQuiet('timer'); }, Math.min(wait, 2 ** 31 - 1));
}

/** Redirects for a silent renew when it's needed and allowed. Returns true when a redirect started. */
function renewNow(reason) {
  if (S.mode !== 'drive' || S.redirecting || !hasClientId() || !navigator.onLine) return false;
  if (reason !== '401' && tokenLeft() > RENEW_AHEAD) return false;   // plenty of time left
  if (videoPlaying()) { S.renewWhenIdle = true; return false; }      // never interrupt playback
  if (!canTrySilent()) return false;                                 // one attempt per 2 minutes
  saveUiState();
  S.redirecting = true;
  setNotice('Refreshing…');
  signIn({ silent: true });
  return true;
}

/**
 * Drive said 401 for `tokUsed`. Renew in the background and report true so the request is retried;
 * otherwise fall back to the redirect, and the Reconnect pill as the last resort.
 */
async function onAuthExpired(tokUsed) {
  if (S.mode !== 'drive' || S.redirecting) return false;
  if (tokUsed && token() && token() !== tokUsed && tokenValid()) return true;   // already renewed meanwhile
  expireToken();
  if (await renewQuiet('401')) return true;
  if (renewNow('401') || S.renewWhenIdle) return false;
  if (navigator.onLine) onAuthLost();
  else setNotice('Offline · saved library');
  return false;
}

/** After a background renew, a failed step may run once more — not again within 30 s (no loops). */
function mayRetryAuth() {
  const now = Date.now();
  if (now - (S.authRetryAt || 0) < 30_000) return false;
  S.authRetryAt = now;
  return true;
}

function onResume() {
  if (document.hidden || S.mode !== 'drive' || S.redirecting) return;
  if (S.renewWhenIdle && !videoPlaying()) S.renewWhenIdle = false;
  scheduleRenew();
  renewSoon('resume');
}

/** Interactive sign-in (with login_hint), UI state saved like any renew. */
function reconnect() {
  saveUiState();
  S.redirecting = true;
  signIn({ silent: false });
}

function saveUiState() {
  const st = {
    t: Date.now(),
    modeKey: S.modeKey,
    libId: S.lib ? S.lib.id : null,
    view: S.view,
    search: S.search.active ? { q: S.search.q, tags: S.search.tags, scroll: S.search.scroll || 0 } : null,
    scrollY: Math.round(scrollY),
  };
  const slot = viewer.isOpen && viewer.cur;
  if (slot && slot.item) {
    st.viewer = { id: slot.item.id };
    const v = slot.video;
    if (v) {
      const r = S.resumeVideo && S.resumeVideo.id === slot.item.id ? S.resumeVideo : null;
      st.viewer.video = r ? { t: r.t, playing: r.playing } : { t: slot.lastTime != null ? slot.lastTime : v.currentTime, playing: !v.paused };
    }
  }
  lsSet(RESUME_KEY, st);
}

function takeResume(lib) {
  const st = lsGet(RESUME_KEY);
  if (!st) return null;
  lsSet(RESUME_KEY, null);
  if (Date.now() - st.t > RESUME_TTL || st.modeKey !== S.modeKey || st.libId !== lib.id) return null;
  return st;
}

/** Put search, scroll position and the open viewer (and its video time) back exactly. */
async function restoreUi(st) {
  if (st.search) {
    openSearch({ tags: st.search.tags || [], focus: false });
    el.searchInput.value = st.search.q || '';
    S.search.q = st.search.q || '';
    S.search.scroll = st.search.scroll || 0;
    renderSearch();
  }
  await nextFrame();
  await nextFrame();
  scrollTo(0, st.scrollY || 0);
  if (st.viewer) {
    const i = S.list.findIndex((it) => it.id === st.viewer.id);
    if (i >= 0) viewer.open(S.list, i, null, { resume: st.viewer.video || null });
  }
}

async function afterConnect() {
  const saved = lsGet(`perch.lib.${S.modeKey}`);
  if (saved) return openLibrary(saved);
  return showLibraries();
}

// ── screens ──────────────────────────────────────────────────────────────────
function showScreen(name) {
  for (const n of ['onboard', 'libs', 'syncing', 'main']) el[n].hidden = n !== name;
  S.screen = name;
  el.dock.hidden = name !== 'main' || S.search.active;
  if (name !== 'main') el.topbar.classList.remove('on');
  else {
    requestAnimationFrame(() => { measureHero(); grid.measureTop(); grid.render(); onScroll(); });
    if (S.model) maybeShowInstallCard();
    setTimeout(handleSharedLink, 0);
  }
}

function showOnboarding() {
  showScreen('onboard');
  buildWall();
}

async function buildWall() {
  if (el.wall.childElementCount) return;
  try {
    const m = await (await fetch('demo/manifest.json')).json();
    const thumbs = m.files.filter((f) => /_thumbnail\.png$/.test(f.name) && f.url && f.url.startsWith('Demo.library'))
      .map((f) => new URL(`demo/${f.url}`, document.baseURI).href);
    if (!thumbs.length) return;
    const cols = [h('div', { class: 'wall-col' }), h('div', { class: 'wall-col' }), h('div', { class: 'wall-col' })];
    let loaded = 0;
    const per = Math.ceil(thumbs.length / 3) + 4;
    cols.forEach((c, ci) => {
      for (let k = 0; k < per; k++) {
        const img = h('img', { alt: '', decoding: 'async', src: thumbs[(ci * 7 + k * 3) % thumbs.length] });
        img.onload = () => { if (++loaded === 9) el.wall.classList.add('in'); };
        c.append(img);
      }
    });
    el.wall.append(...cols);
  } catch { /* the wall is decoration */ }
}

$('#btn-demo').addEventListener('click', () => {
  lsSet('perch.mode', { mode: 'demo', manifest: 'demo/manifest.json', scale: 0, latency: 140 });
  location.replace(`${location.pathname}?demo=1`);
});

$('#btn-connect').addEventListener('click', () => {
  if (!hasClientId()) { showSetupNote(); return; }
  lsSet('perch.mode', { mode: 'drive' });
  signIn();
});

function showSetupNote() {
  openSheet({
    title: 'One-time setup',
    sub: 'Google needs to know this app before it can read your Drive.',
    body: [
      h('div', { class: 'prose' },
        h('p', null, 'Create an OAuth client ID (type “Web application”) in Google Cloud, add this address as an authorized origin and redirect URI:'),
        h('p', { style: { margin: '10px 0' } }, h('code', null, redirectUri())),
        h('p', null, 'Then paste the client ID into ', h('code', null, 'config.js'), '. The README walks through every step.')),
      h('div', { class: 'form' }, h('button', { class: 'btn-primary', type: 'button', onclick: () => closeSheet() }, 'Got it')),
    ],
  });
}

// ── libraries ────────────────────────────────────────────────────────────────
async function showLibraries() {
  showScreen('libs');
  el.libList.replaceChildren();
  el.libsSub.textContent = 'Looking for Eagle libraries…';
  try {
    S.libs = withPasted(await discoverLibraries(S.drive));
  } catch (e) {
    return handleFatal(e);
  }
  if (S.libs.length === 1) return openLibrary(S.libs[0]);
  renderLibraryList();
}

function renderLibraryList() {
  const n = S.libs.length;
  el.libsSub.textContent = n ? `${n} ${n === 1 ? 'library' : 'libraries'} in ${S.mode === 'demo' ? 'the demo Drive' : 'your Drive'}` : '';
  if (!n) {
    el.libList.replaceChildren(h('li', { class: 'libs-empty' }, 'No Eagle libraries found. If your library lives in a shared folder, paste its link below.'));
    return;
  }
  el.libList.replaceChildren(...S.libs.map((lib) => h('li', null, h('button', { class: 'lib-row', type: 'button', onclick: () => openLibrary(lib) },
    h('span', { class: 'lib-glyph', html: I.stack }),
    h('span', { class: 'lib-text' }, h('div', { class: 'lib-name', dir: 'auto' }, lib.name), h('div', { class: 'lib-meta' }, lib.modifiedTime ? `Updated ${timeAgo(Date.parse(lib.modifiedTime))}` : 'Eagle library')),
    h('span', { class: 'chev-r', html: I.chevronR })))));
}

$('#btn-paste').addEventListener('click', () => openPasteLink());

function openPasteLink() {
  const input = h('input', { class: 'field', type: 'url', placeholder: 'https://drive.google.com/drive/folders/…', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'go' });
  const err = h('div', { class: 'err' });
  const go = async () => {
    err.textContent = '';
    try {
      const libs = await resolveFolderLink(S.drive, input.value);
      rememberPasted(libs);
      for (const l of libs) if (!S.libs.some((x) => x.id === l.id)) S.libs.push(l);
      await closeSheet();
      if (libs.length === 1) openLibrary(libs[0]);
      else { showScreen('libs'); renderLibraryList(); }
    } catch (e) {
      err.textContent = e.name === 'DriveError' && e.status === 404 ? 'Folder not found, or not shared with this account.' : e.message;
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  openSheet({
    title: 'Open from link',
    sub: 'A link to a .library folder, or to the folder that holds your libraries.',
    body: h('div', { class: 'form' }, input, err, h('button', { class: 'btn-primary', type: 'button', onclick: go }, 'Open')),
  });
  setTimeout(() => input.focus(), 350);
}

// Libraries opened from a pasted link (often shared with you, so discovery can't find them) are remembered.
const pastedKey = () => `perch.pasted.${S.modeKey}`;
function rememberPasted(libs) {
  const list = lsGet(pastedKey(), []);
  for (const l of libs) if (!list.some((x) => x.id === l.id)) list.push({ id: l.id, name: l.name, modifiedTime: l.modifiedTime });
  lsSet(pastedKey(), list);
}
function withPasted(libs) {
  const out = [...libs];
  for (const l of lsGet(pastedKey(), [])) if (l && l.id && !out.some((x) => x.id === l.id)) out.push(l);
  return out;
}

const snapKey = (libId) => `snap:${S.modeKey}:${libId}`;

async function openLibrary(lib) {
  S.lib = lib;
  lsSet(`perch.lib.${S.modeKey}`, lib);
  S.view = lsGet(`perch.view.${S.modeKey}.${lib.id}`, { type: 'all' });
  S.snap = null;
  S.model = null;
  setThumbSource(S.drive);
  const snap = await kv.get(snapKey(lib.id)).catch(() => null);
  if (snap) {
    const resume = takeResume(lib);
    applySnapshot(snap, { reveal: !resume });
    showScreen('main');
    if (resume) await restoreUi(resume);
    if (S.mode !== 'drive' || tokenValid()) runSync({ background: true });
  } else {
    showSyncScreen(lib);
    runSync({ first: true });
  }
}

function showSyncScreen(lib) {
  showScreen('syncing');
  el.syncLib.textContent = lib.name;
  el.syncBar.parentElement.classList.add('indeterminate');
  el.syncBar.style.transform = '';
  el.syncCount.textContent = 'Reading library';
}

function firstSyncProgress(p) {
  const bar = el.syncBar.parentElement;
  if (p.phase === 'meta' && p.total) {
    bar.classList.remove('indeterminate');
    const f = 0.08 + 0.92 * (p.done / p.total);
    el.syncBar.style.transform = `scaleX(${f})`;
    el.syncCount.textContent = `Reading references · ${Math.round(f * 100)}%`;
  } else if (p.phase === 'scan' && p.total) {
    bar.classList.remove('indeterminate');
    el.syncBar.style.transform = `scaleX(${0.08 * (p.done / p.total)})`;
    el.syncCount.textContent = 'Finding references';
  } else if (p.phase === 'list') {
    el.syncCount.textContent = 'Finding references';
  }
}

// A sync belongs to one library. Opening another library while it runs starts that library's own sync;
// the older one finishes quietly and only the newest sync owns the flags.
let syncGen = 0;
async function runSync({ first = false, full = false, background = false } = {}) {
  if (!S.lib || (S.syncing && S.syncingLib && S.syncingLib.id === S.lib.id)) return;
  const gen = ++syncGen;
  S.syncing = true;
  const lib = S.lib;
  S.syncingLib = lib;
  const current = () => S.lib && S.lib.id === lib.id;
  if (!first) el.spin.hidden = false;
  try {
    const { snap, stats } = await syncLibrary(S.drive, lib, full ? null : S.snap, { full, onProgress: first ? (p) => { if (current()) firstSyncProgress(p); } : () => {} });
    if (!current()) return;
    console.info('[perch] sync', stats);
    S.lastStats = stats;
    await kv.set(snapKey(lib.id), snap).catch((e) => console.warn('[perch] could not cache library', e));
    const changed = first || full || stats.fetched > 0 || stats.removed > 0 || !S.snap || snap.metaModified !== S.snap.metaModified;
    if (first) {
      applySnapshot(snap, { reveal: true });
      showScreen('main');
    } else if (changed) {
      applySnapshot(snap, { keepScroll: true });
    } else {
      S.snap = snap;
    }
    const n = stats.failed || 0;
    if (n) setNotice(`${n.toLocaleString('en')} ${n === 1 ? 'reference' : 'references'} couldn’t be read · Retry`, () => runSync());
    else setNotice(null);
  } catch (e) {
    if (!current()) return;
    if (e.name === 'AuthError') {
      if (await onAuthExpired()) { if (mayRetryAuth()) setTimeout(() => runSync({ first, full, background }), 0); return; }   // renewed: go again
      if (first && !S.redirecting) showOnboarding();
      return;
    }
    console.warn('[perch] sync failed', e);
    if (first) showSyncError(e);
    else setNotice(navigator.onLine ? 'Couldn’t sync · Retry' : 'Offline · saved library', () => runSync());
  } finally {
    if (gen === syncGen) {
      S.syncing = false;
      S.syncingLib = null;
      el.spin.hidden = true;
      endPull();
    }
  }
}

function showSyncError(e) {
  el.syncBar.parentElement.classList.remove('indeterminate');
  el.syncBar.style.transform = 'scaleX(0)';
  el.syncCount.replaceChildren(
    h('span', null, e.message || 'Sync failed'), h('br'),
    h('button', { class: 'btn-quiet', type: 'button', style: { height: '40px', marginTop: '8px' }, onclick: () => { showSyncScreen(S.lib); runSync({ first: true }); } }, 'Try again'),
    h('button', { class: 'btn-quiet', type: 'button', style: { height: '40px', marginTop: '8px', marginLeft: '12px' }, onclick: () => showLibraries() }, 'Libraries'));
}

function handleFatal(e) {
  if (e.name === 'AuthError') { onAuthExpired().then((ok) => { if (ok) { if (mayRetryAuth()) showLibraries(); } else if (!S.redirecting) showOnboarding(); }); return; }
  el.libsSub.textContent = e.message || 'Something went wrong';
}

function onAuthLost() {
  if (S.mode !== 'drive') return;
  S.authLost = true;
  expireToken();
  setNotice('Reconnect Google Drive', reconnect);
}

function setNotice(text, action) {
  if (!text) { if (!el.notice.hidden) { el.notice.hidden = true; requestAnimationFrame(() => { grid.measureTop(); measureHero(); }); } return; }
  const shown = el.notice.hidden;
  el.notice.hidden = false;
  el.notice.replaceChildren(h('i', { class: 'dot' }), h('span', null, text));
  el.notice.onclick = action || null;
  el.notice.setAttribute('role', action ? 'button' : 'status');
  if (shown) requestAnimationFrame(() => { grid.measureTop(); measureHero(); });
}

// ── model → screen ───────────────────────────────────────────────────────────
function applySnapshot(snap, { reveal = false, keepScroll = false } = {}) {
  S.snap = snap;
  S.model = new Library(snap);
  S.model.setUnlocked(S.unlocked);
  const v = S.view;
  if (v.type === 'folder' && (!S.model.folders.has(v.id) || S.model.isLocked(v.id))) S.view = { type: 'all' };
  render({ reveal, keepScroll });
  prefetch(S.model.items.map(thumbIdOf).filter(Boolean));
}

function render({ reveal = false, keepScroll = false } = {}) {
  const m = S.model;
  if (!m) return;
  const searching = S.search.active;
  S.list = searching ? m.search(m.visible, S.search.q, S.search.tags) : m.list(S.view);
  const title = m.viewName(S.view);
  el.libName.textContent = S.lib?.name || '';
  el.title.textContent = title;
  el.topbarTitle.textContent = title;
  el.count.textContent = S.list.length.toLocaleString('en');
  document.title = `${title} · Perch`;
  grid.setItems(S.list, { reveal, keepScroll });
  updateEmpty();
  measureHero();
  if (searching) renderSearchMeta();
}

function updateEmpty() {
  const m = S.model;
  const searching = S.search.active;
  const noQuery = searching && !S.search.q && !S.search.tags.length;
  const empty = !S.list.length && !noQuery;
  el.empty.hidden = !empty;
  if (!empty) return;
  if (searching) el.empty.replaceChildren(h('strong', null, 'No matches'), 'Try another word or tag.');
  else if (m && !m.items.length) el.empty.replaceChildren(h('strong', null, 'Empty library'), 'Add references in Eagle and they’ll appear here after the next sync.');
  else el.empty.replaceChildren(h('strong', null, 'Nothing here yet'), 'This folder has no references.');
}

function selectView(view) {
  if (S.search.active) closeSearch({ silent: true });
  S.view = view;
  if (S.lib) lsSet(`perch.view.${S.modeKey}.${S.lib.id}`, view);
  render({ reveal: true });
}

function setColumns(n, anchorY) {
  n = clamp(n, 2, 3);
  lsSet('perch.cols', n);
  grid.setPreference(n, anchorY);
}

// ── header, topbar, dock behaviour on scroll ─────────────────────────────────
let heroEdge = 0, lastY = 0;
function measureHero() {
  if (S.screen !== 'main' || S.search.active) return;
  const r = el.title.getBoundingClientRect();
  heroEdge = r.bottom + scrollY - (el.topbar.offsetHeight || 44) - 4;
}
addEventListener('resize', measureHero, { passive: true });
addEventListener('scroll', onScroll, { passive: true });
function onScroll() {
  if (S.screen !== 'main') return;
  const y = scrollY;
  el.topbar.classList.toggle('on', !S.search.active && y > heroEdge);
  if (!S.search.active) {
    if (y > lastY + 8 && y > 160) el.dock.classList.add('away');
    else if (y < lastY - 8 || y < 80) el.dock.classList.remove('away');
  }
  lastY = y;
}
el.topbar.addEventListener('click', () => scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' }));

// ── pull to refresh ──────────────────────────────────────────────────────────
let pull = null;
const PULL_TRIGGER = 72;
addEventListener('touchstart', (e) => {
  if (S.screen !== 'main' || viewer.isOpen || isSheetOpen() || S.search.active || S.syncing || scrollY > 0 || e.touches.length !== 1) return;
  pull = { y0: e.touches[0].clientY, d: 0 };
}, { passive: true });
addEventListener('touchmove', (e) => {
  if (!pull) return;
  const dy = e.touches[0].clientY - pull.y0;
  if (dy <= 0 || scrollY > 0) { if (pull.d) setPull(0); pull.d = 0; return; }
  pull.d = rubberband(dy, innerHeight, 0.55);
  setPull(pull.d);
}, { passive: true });
addEventListener('touchend', () => {
  if (!pull) return;
  const d = pull.d;
  pull = null;
  if (d >= PULL_TRIGGER && S.mode) {
    el.ptr.classList.add('spinning');
    el.ptr.style.opacity = '1';
    settlePull(44);
    runSync();
  } else settlePull(0);
}, { passive: true });

function setPull(d) {
  el.content.style.transform = d ? `translateY(${d}px)` : '';
  el.ptr.style.opacity = String(clamp(d / 36, 0, 1));
  el.ptrArc.style.strokeDashoffset = String(56.55 * (1 - clamp(d / PULL_TRIGGER, 0, 1)));
}
function settlePull(to) {
  const from = parseFloat((el.content.style.transform.match(/-?[\d.]+/) || [0])[0]) || 0;
  el.content.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }], { duration: 320, easing: 'cubic-bezier(.23,1,.32,1)' });
  el.content.style.transform = to ? `translateY(${to}px)` : '';
  if (!to && !el.ptr.classList.contains('spinning')) el.ptr.style.opacity = '0';
}
function endPull() {
  if (!el.ptr.classList.contains('spinning')) return;
  el.ptr.classList.remove('spinning');
  el.ptr.style.opacity = '0';
  el.ptrArc.style.strokeDashoffset = '56.55';
  settlePull(0);
}

// ── dock ─────────────────────────────────────────────────────────────────────
el.dock.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'folders') openFolders();
  else if (b.dataset.act === 'search') openSearch();
  else if (b.dataset.act === 'more') openMore();
});
$('#lib-switch').addEventListener('click', () => openLibrarySwitcher());

// ── folders ──────────────────────────────────────────────────────────────────
function openFolders() {
  const m = S.model;
  if (!m) return;
  if (S.view.type === 'folder') for (const f of m.folderPath(S.view.id).slice(0, -1)) S.expanded.add(f.id);
  const sheet = openSheet({ title: 'Folders', sub: S.lib?.name, body: folderRows() });
  function folderRows() {
    const rows = [
      viewRow({ type: 'all' }, I.all, 'All', m.visible.length),
      viewRow({ type: 'uncat' }, I.inbox, 'Uncategorized', m.uncategorized.length),
    ];
    if (m.roots.length) rows.push(h('div', { class: 'sep' }));
    const walk = (nodes) => {
      for (const n of nodes) {
        rows.push(folderRow(n));
        if (n.children.length && S.expanded.has(n.id)) walk(n.children);
      }
    };
    walk(m.roots);
    if (!m.roots.length) rows.push(h('div', { class: 'group-label' }, 'No folders in this library'));
    return rows;
  }
  function viewRow(view, icon, label, n) {
    const sel = S.view.type === view.type;
    return h('button', { class: `row${sel ? ' sel' : ''}`, type: 'button', onclick: () => { sheet.close(); selectView(view); } },
      h('span', { class: 'ico', html: icon }), h('span', { class: 'label' }, label), h('span', { class: 'n' }, n.toLocaleString('en')), h('span', { class: 'tw blank' }));
  }
  function folderRow(n) {
    const locked = m.isLocked(n.id);
    const sel = S.view.type === 'folder' && S.view.id === n.id;
    let tw = null;
    if (n.children.length) {
      tw = h('span', { class: `tw${S.expanded.has(n.id) ? ' open' : ''}`, role: 'button', 'aria-label': S.expanded.has(n.id) ? 'Collapse' : 'Expand', html: I.chevronR });
      tw.addEventListener('click', (e) => {
        e.stopPropagation();
        if (S.expanded.has(n.id)) S.expanded.delete(n.id); else S.expanded.add(n.id);
        sheet.setBody(folderRows());
      });
    }
    const color = FOLDER_COLORS[n.color];
    return h('button', {
      class: `row${sel ? ' sel' : ''}`, type: 'button', style: { paddingLeft: `${12 + n.depth * 22}px` },
      onclick: () => { if (locked) { unlockFolder(n); return; } sheet.close(); selectView({ type: 'folder', id: n.id }); },
    },
    h('span', { class: 'ico' }, h('span', { class: `dot${color ? '' : ' none'}`, style: color ? { background: color } : null })),
    h('span', { class: 'label', dir: 'auto' }, n.name),
    locked ? h('span', { class: 'lock', html: I.lock }) : h('span', { class: 'n' }, (m.counts.get(n.id) || 0).toLocaleString('en')),
    tw || h('span', { class: 'tw blank' }));
  }
}

function unlockFolder(node) {
  const input = h('input', { class: 'field', type: 'password', placeholder: 'Password', autocomplete: 'off', enterkeyhint: 'go' });
  const err = h('div', { class: 'err' });
  const go = async () => {
    // Eagle keeps the folder password in its metadata; compare locally, never sent anywhere.
    let target = node;
    for (const f of S.model.folderPath(node.id)) if (f.password && !S.unlocked.has(f.id)) { target = f; break; }
    if (input.value !== target.password) { err.textContent = 'Wrong password'; input.select(); return; }
    S.unlocked.add(target.id);
    saveUnlocked();
    S.model.setUnlocked(S.unlocked);
    render({ keepScroll: true });
    if (S.model.isLocked(node.id)) { input.value = ''; err.textContent = 'This folder sits inside another locked folder'; return; }
    await closeSheet();
    selectView({ type: 'folder', id: node.id });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const lockOwner = S.model.folderPath(node.id).find((f) => f.password && !S.unlocked.has(f.id)) || node;
  openSheet({
    title: lockOwner.name,
    sub: 'This folder is locked in Eagle.',
    body: h('div', { class: 'form' }, input, lockOwner.tips ? h('div', { class: 'hint' }, `Hint: ${lockOwner.tips}`) : null, err,
      h('button', { class: 'btn-primary', type: 'button', onclick: go }, 'Unlock')),
  });
  setTimeout(() => input.focus(), 350);
}

function readUnlocked() {
  try { return JSON.parse(sessionStorage.getItem('perch.unlocked') || '[]'); } catch { return []; }
}
function saveUnlocked() {
  try { sessionStorage.setItem('perch.unlocked', JSON.stringify([...S.unlocked])); } catch { /* ignore */ }
}

// ── more ─────────────────────────────────────────────────────────────────────
function openMore() {
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'Columns' }, [2, 3].map((n) => h('button', {
    type: 'button', class: grid.pref === n ? 'on' : '', role: 'radio', 'aria-checked': String(grid.pref === n),
    onclick: (e) => {
      e.stopPropagation();
      setColumns(n);
      for (const b of seg.children) { b.classList.toggle('on', b === e.currentTarget); b.setAttribute('aria-checked', String(b === e.currentTarget)); }
    },
  }, String(n))));
  const syncMeta = h('span', { class: 'meta' }, S.syncing ? 'Syncing…' : S.snap ? timeAgo(S.snap.lastSync) : '');
  const sheet = openSheet({
    title: S.lib?.name || 'Perch',
    sub: S.snap ? `${S.model.visible.length.toLocaleString('en')} references` : '',
    body: [
      h('button', { class: 'row', type: 'button', onclick: async () => { await sheet.close(); openLibrarySwitcher(); } },
        h('span', { class: 'ico', html: I.library }), h('span', { class: 'label' }, 'Switch library'), h('span', { class: 'ico', html: I.chevronR })),
      h('div', { class: 'row', style: { cursor: 'default' } },
        h('span', { class: 'ico', html: I.columns }), h('span', { class: 'label' }, 'Columns'), seg),
      h('button', { class: 'row', type: 'button', onclick: () => { sheet.close(); runSync(); } },
        h('span', { class: 'ico', html: I.sync }), h('span', { class: 'label' }, 'Sync now'), syncMeta),
      h('button', { class: 'row', type: 'button', onclick: async () => { await sheet.close(); openSaveLink(); } },
        h('span', { class: 'ico', html: I.inbox }), h('span', { class: 'label' }, 'Save to Eagle'), h('span', { class: 'ico', html: I.chevronR })),
      canInstall() ? h('button', { class: 'row', type: 'button', onclick: async () => { await sheet.close(); openInstallSheet(); } },
        h('span', { class: 'ico', html: I.plusSquare }), h('span', { class: 'label' }, 'Install app')) : null,
      h('div', { class: 'sep' }),
      S.mode === 'demo'
        ? h('button', { class: 'row', type: 'button', onclick: exitDemo }, h('span', { class: 'ico', html: I.signout }), h('span', { class: 'label' }, 'Exit demo'))
        : h('button', { class: 'row danger', type: 'button', onclick: confirmSignOut }, h('span', { class: 'ico', html: I.signout }), h('span', { class: 'label' }, 'Sign out')),
      h('div', { class: 'foot-note' },
        S.mode === 'demo' ? 'Demo library · ' : canWrite() ? 'Google Drive · ' : 'Google Drive · read-only · ',
        h('button', { type: 'button', style: { textDecoration: 'underline', color: 'inherit', fontSize: 'inherit' }, onclick: () => { sheet.close(); runSync({ full: true }); } }, 'Rebuild cache')),
    ],
  });
}

async function openLibrarySwitcher() {
  const body = () => [
    ...S.libs.map((lib) => h('button', { class: `row${S.lib && lib.id === S.lib.id ? ' sel' : ''}`, type: 'button', onclick: async () => { await sheet.close(); if (!S.lib || lib.id !== S.lib.id) openLibrary(lib); } },
      h('span', { class: 'ico', html: I.stack }), h('span', { class: 'label', dir: 'auto' }, lib.name),
      S.lib && lib.id === S.lib.id ? h('span', { class: 'ico', html: I.check }) : null)),
    h('div', { class: 'sep' }),
    h('button', { class: 'row', type: 'button', onclick: async () => { await sheet.close(); openPasteLink(); } },
      h('span', { class: 'ico', html: I.link }), h('span', { class: 'label' }, 'Open from link')),
  ];
  const sheet = openSheet({ title: 'Libraries', body: S.libs.length ? body() : h('div', { class: 'group-label' }, 'Looking for libraries…') });
  if (!S.libs.length) {
    try { S.libs = withPasted(await discoverLibraries(S.drive)); sheet.setBody(body()); } catch (e) { sheet.setBody(h('div', { class: 'group-label' }, e.message)); }
  }
}

// ── send to Eagle ────────────────────────────────────────────────────────────
// Both ways go through the Drive inbox that Video Grabber (in Eagle on the computer) reads:
// • a video the phone already has (shared from a downloader app such as YTDLnis, or picked here): Perch
//   uploads it, and Eagle only has to add it when it opens — the computer downloads nothing;
// • a link: Video Grabber downloads it the next time Eagle is open.

const canSend = () => S.mode === 'demo' || (S.mode === 'drive' && canWrite());
const uploadListeners = new Set();

/** The upload queue (created on first use: boot runs before this part of the module). */
function up() {
  if (!uploader) {
    uploader = createUploader({
      ctx: () => ({ drive: S.drive, modeKey: S.modeKey, library: S.lib, writable: canSend() }),
      onChange: (items) => { for (const fn of uploadListeners) fn(items); },
      onSaved: (it) => { if (!S.shareOpen) toast('Sent to Eagle', it.name ? ` · ${it.name}` : ''); },
    });
    S.uploader = uploader;   // for devtools
  }
  return uploader;
}

/** First upload: Google asks once to let Perch create files (it only ever sees files it made). */
function askWrite() {
  lsSet(SHARE_FILES_KEY, Date.now());
  saveUiState();
  S.redirecting = true;
  signIn({ write: true });
}

/** The share sheet opened Perch: a link (?share_url / share_text / share_title) or files (?shared=n, kept by the service worker). */
function takeSharedLink(params) {
  const keys = ['share_url', 'share_text', 'share_title'];
  if (![...keys, 'shared'].some((k) => params.has(k))) return;
  const shared = params.get('shared');
  const url = extractUrl(...keys.map((k) => params.get(k)));
  for (const k of [...keys, 'shared']) params.delete(k);
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  if (shared === 'failed') setTimeout(() => toast('Couldn’t receive what you shared'), 500);
  else if (shared && shared !== 'empty') lsSet(SHARE_FILES_KEY, Date.now());
  else if (url) lsSet(SHARE_KEY, { url, t: Date.now() });
  else setTimeout(() => toast('There was no link in what you shared'), 500);
}

function handleSharedLink() {
  if (S.screen !== 'main' || S.redirecting) return;
  if (canSend()) up().run();
  if (S.shareOpen) return;
  const files = lsGet(SHARE_FILES_KEY);
  if (files) {
    lsSet(SHARE_FILES_KEY, null);
    if (Date.now() - files < SHARE_TTL) { openSaveLink(); return; }
  }
  const p = lsGet(SHARE_KEY);
  if (!p) return;
  if (Date.now() - p.t > SHARE_TTL) { lsSet(SHARE_KEY, null); return; }
  openSaveLink({ url: p.url, auto: true });
}

const LINK_STATUS = {
  pending: 'Saved · Eagle on PC downloads it',
  queued: 'Downloading…',
  downloading: 'Downloading…',
  done: 'Added to Eagle',
  error: 'Couldn’t download',
};
const FILE_STATUS = { ...LINK_STATUS, pending: 'Uploaded · waiting for Eagle on PC', queued: 'Adding to Eagle…', downloading: 'Adding to Eagle…', error: 'Couldn’t add' };

function openSaveLink({ url = '', auto = false } = {}) {
  const writable = canSend();
  const libName = (S.lib?.name || '').replace(/\.library$/i, '');
  const input = h('input', { class: 'field', type: 'url', placeholder: 'Paste a video link', value: url, autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send' });
  const err = h('div', { class: 'err' });
  const saveBtn = h('button', { class: 'btn-primary', type: 'button' }, writable ? 'Save link' : 'Allow & save');
  const recent = h('div', { class: 'link-list' });
  const done = h('div', { class: 'link-done', hidden: true });
  const uploads = h('div', { class: 'link-list' });

  // ── a video already on the phone
  const picker = h('input', { type: 'file', accept: 'video/*,image/*', multiple: true, hidden: true });
  const upBtn = h('button', { class: 'btn-fill', type: 'button', onclick: () => {
    if (canSend() || !up().list().some((it) => it.status !== 'saved')) picker.click();
    else askWrite();
  } }, h('span', { class: 'ico', html: I.inbox }), 'Upload a video from this phone');
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    if (!files.length) return;
    try { await stash(files); } catch (e) { toast('Couldn’t read that file'); return; }
    if (canSend()) up().run(); else askWrite();
  });

  let lastSaved = 0;
  let frame = 0;
  const pct = (it) => (it.size ? Math.floor((100 * it.sent) / it.size) : 0);
  const upText = (it) => ({
    waiting: `Waiting · ${fmtBytes(it.size)}`,
    uploading: it.sent ? `Uploading ${pct(it)}% · ${fmtBytes(it.sent)} of ${fmtBytes(it.size)}` : `Uploading · ${fmtBytes(it.size)}`,
    error: `Couldn’t upload · ${it.error}`,
  }[it.status] || '');
  function renderUploads(items) {
    const saved = items.filter((it) => it.status === 'saved').length;
    if (saved > lastSaved) { lastSaved = saved; loadRecent(); }
    const open = items.filter((it) => it.status !== 'saved');
    if (!open.length) { uploads.replaceChildren(); upBtn.lastChild.textContent = 'Upload a video from this phone'; return; }
    const blocked = !canSend();
    upBtn.lastChild.textContent = blocked ? 'Allow & upload' : 'Upload another video';
    uploads.replaceChildren(
      h('div', { class: 'group-label' }, 'Uploading to Drive'),
      ...open.map((it) => h('div', { class: `link-row ${it.status}` },
        h('span', { class: 'link-dot' }),
        h('div', { class: 'link-text' },
          h('div', { class: 'link-title', dir: 'auto' }, it.name || 'Video'),
          h('div', { class: 'link-meta' }, blocked && it.status === 'waiting' ? 'Waiting for Google’s OK' : upText(it)),
          it.status === 'uploading' ? h('div', { class: 'up-bar' }, h('i', { style: { width: `${pct(it)}%` } })) : null),
        it.status === 'error' ? h('button', { class: 'link-retry', type: 'button', onclick: () => (it.scope || !canSend() ? askWrite() : up().retry()) }, 'Retry') : null)),
      open.some((it) => it.status === 'uploading') ? h('p', { class: 'link-note up-note' }, 'Keep Perch open until it finishes. If it closes, the upload carries on next time.') : null);
  }
  const onUploads = (items) => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => renderUploads(items)); };

  // ── a link (Video Grabber downloads it)
  async function save() {
    err.textContent = '';
    const link = extractUrl(input.value);
    if (!link) { err.textContent = 'That doesn’t look like a link.'; return; }
    if (!writable) {
      // First time: Google asks once to let Perch create files (it only ever sees files it made).
      lsSet(SHARE_KEY, { url: link, t: Date.now() });
      saveUiState();
      S.redirecting = true;
      signIn({ write: true });
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await saveLink(S.drive, S.modeKey, { url: link, library: S.lib });
      lsSet(SHARE_KEY, null);
      input.value = '';
      done.hidden = false;
      done.replaceChildren(h('span', { class: 'ico', html: I.check }),
        h('div', null, h('div', { class: 'link-done-title' }, 'Saved'),
          h('div', { class: 'link-done-sub' }, `It downloads into ${libName ? `“${libName}”` : 'Eagle'} the next time Eagle is open on your computer.`)));
      loadRecent();
    } catch (e) {
      const scope = e.name === 'DriveError' && e.status === 403 && /insufficient|scope|permission/i.test(e.message);
      if (scope) { lsSet(SHARE_KEY, { url: link, t: Date.now() }); saveUiState(); S.redirecting = true; signIn({ write: true }); return; }
      err.textContent = e.name === 'AuthError' ? 'Google sign-in expired — try again.' : (e.message || 'Couldn’t save the link');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save link';
    }
  }

  async function loadRecent() {
    try {
      const rows = await recentLinks(S.drive, S.modeKey);
      if (!rows.length) { recent.replaceChildren(); return; }
      recent.replaceChildren(h('div', { class: 'group-label' }, 'Recent'), ...rows.map((r) => {
        const file = r.kind === 'file';
        const status = (file ? FILE_STATUS : LINK_STATUS)[r.status || 'pending'] || (file ? FILE_STATUS : LINK_STATUS).pending;
        return h('div', { class: `link-row ${r.status || ''}` },
          h('span', { class: 'link-dot' }),
          h('div', { class: 'link-text' },
            h('div', { class: 'link-title', dir: 'auto' }, r.status === 'done' && r.title ? r.title : file ? (r.name || 'Video') : siteOf(r.url || '')),
            h('div', { class: 'link-meta' }, [status, r.status === 'error' && r.error ? ` · ${String(r.error).slice(0, 80)}` : '', r.sentAt ? ` · ${timeAgo(Date.parse(r.sentAt))}` : ''].join(''))));
      }));
      // Something landed in Eagle since the last sync: fetch it.
      if (S.snap && rows.some((r) => r.status === 'done' && Date.parse(r.doneAt || 0) > S.snap.lastSync)) runSync({ background: true });
    } catch { /* the list is a nicety */ }
  }

  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const paste = navigator.clipboard && navigator.clipboard.readText
    ? h('button', { class: 'btn-quiet', type: 'button', onclick: async () => { try { const t = await navigator.clipboard.readText(); const u = extractUrl(t); if (u) input.value = u; else err.textContent = 'No link on the clipboard.'; } catch { /* refused */ } } }, 'Paste')
    : null;
  const phone = h('div', { class: 'form' },
    upBtn, picker,
    h('p', { class: 'link-note' }, `Already downloaded? Eagle adds it to ${libName ? `“${libName}”` : 'the library'} as soon as it opens — your computer downloads nothing.`));
  const form = h('div', { class: 'form' },
    h('div', { class: 'group-label flush' }, 'Or a link'),
    h('div', { class: 'field-row' }, input, paste), err,
    h('p', { class: 'link-note' }, 'Video Grabber downloads it when Eagle is open on your computer.'),
    saveBtn);
  S.shareOpen = true;
  uploadListeners.add(onUploads);
  openSheet({
    title: 'Save to Eagle',
    sub: writable ? (libName ? `Into “${libName}”` : '') : 'Google will ask once to let Perch save to your Drive. Perch can only see the files it saves.',
    body: [uploads, phone, done, form, recent],
    onClose: () => { S.shareOpen = false; uploadListeners.delete(onUploads); cancelAnimationFrame(frame); up().clearSaved(); },
  });
  up().refresh();
  if (auto && writable) save();
  if (S.drive) loadRecent();
}

function confirmSignOut() {
  openSheet({
    title: 'Sign out?',
    sub: 'Perch forgets your library on this device. Nothing changes in Drive or Eagle.',
    body: h('div', { class: 'form' }, h('button', { class: 'btn-primary', type: 'button', style: { background: '#ff453a', color: '#fff' }, onclick: doSignOut }, 'Sign out')),
  });
}

async function doSignOut() {
  signOut();
  lsSet('perch.mode', null);
  lsSet('perch.lib.drive', null);
  lsSet('perch.pasted.drive', null);
  await swkv.del('auth');
  await wipeAll();
  location.replace(location.pathname);
}

function exitDemo() {
  lsSet('perch.mode', null);
  location.replace(location.pathname);
}

// ── search ───────────────────────────────────────────────────────────────────
let searchLayer = 0;
function openSearch({ tags = [], focus = true } = {}) {
  if (!S.model) return;
  if (isSheetOpen()) closeSheet();
  if (!S.search.active) {
    hideInstallCard();
    S.search = { active: true, q: '', tags: [...tags], scroll: scrollY };
    document.body.classList.add('searching');
    el.searchbar.hidden = false;
    el.searchbar.classList.remove('enter');
    void el.searchbar.offsetWidth;
    el.searchbar.classList.add('enter');
    el.dock.hidden = true;
    el.topbar.classList.remove('on');
    el.searchInput.value = '';
    searchLayer = layers.push(() => closeSearch({ fromHistory: true }));
  } else {
    S.search.tags = [...new Set([...S.search.tags, ...tags])];
  }
  renderSearch();
  if (focus && !tags.length) setTimeout(() => el.searchInput.focus(), 30);
}

function closeSearch({ fromHistory = false, silent = false } = {}) {
  if (!S.search.active) return;
  const y = S.search.scroll || 0;
  S.search = { active: false, q: '', tags: [] };
  document.body.classList.remove('searching');
  el.searchbar.hidden = true;
  el.suggest.hidden = true;
  el.dock.hidden = S.screen !== 'main';
  el.searchInput.blur();
  if (!fromHistory) layers.remove(searchLayer);
  if (silent) return;
  render({ keepScroll: true });
  requestAnimationFrame(() => scrollTo(0, y));
}

function renderSearch() {
  const { q, tags } = S.search;
  el.searchClear.hidden = !q;
  el.searchTags.replaceChildren(...tags.map((t) => h('button', { class: 'chip on', type: 'button', dir: 'auto', onclick: () => toggleTag(t) }, t, h('span', { html: I.x, style: { display: 'contents' } }))));
  document.documentElement.style.setProperty('--search-h', `${el.searchbar.offsetHeight}px`);
  const empty = !q && !tags.length;
  el.suggest.hidden = !empty;
  if (empty) renderSuggestions();
  render();
}

function renderSearchMeta() {
  const { q, tags } = S.search;
  let n = el.searchTags.querySelector('.search-n');
  if (q || tags.length) {
    if (!n) { n = h('span', { class: 'search-n' }); el.searchTags.append(n); }
    n.textContent = `${S.list.length.toLocaleString('en')} ${S.list.length === 1 ? 'result' : 'results'}`;
  } else if (n) n.remove();
  document.documentElement.style.setProperty('--search-h', `${el.searchbar.offsetHeight}px`);
}

function renderSuggestions() {
  const m = S.model;
  const t = S.snap?.tags || {};
  const valid = (list) => (Array.isArray(list) ? list : []).filter((x) => m.tagCount.has(x));
  const starred = valid(t.starredTags);
  const recent = valid(t.historyTags).filter((x) => !starred.includes(x)).slice(0, 18);
  const popular = [...m.tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k).filter((k) => !starred.includes(k) && !recent.includes(k)).slice(0, 24);
  const chips = (list) => h('div', { class: 'chips' }, list.map((x) => h('button', { class: 'chip', type: 'button', dir: 'auto', onclick: () => toggleTag(x) }, x)));
  const parts = [];
  if (starred.length) parts.push(h('h2', null, 'Starred tags'), chips(starred));
  if (recent.length) parts.push(h('h2', null, 'Recent tags'), chips(recent));
  if (popular.length) parts.push(h('h2', null, 'All tags'), chips(popular));
  if (!parts.length) parts.push(h('p', { class: 'suggest-empty' }, 'Search by name, tag, note, link or file type.'));
  el.suggest.replaceChildren(...parts);
}

function toggleTag(t) {
  const tags = S.search.tags;
  S.search.tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t];
  renderSearch();
}

const onSearchInput = debounce(() => { S.search.q = el.searchInput.value.trim(); renderSearch(); }, 110);
el.searchInput.addEventListener('input', () => { el.searchClear.hidden = !el.searchInput.value; onSearchInput(); });
el.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.searchInput.blur(); if (e.key === 'Escape') closeSearch(); });
el.searchClear.addEventListener('click', () => { el.searchInput.value = ''; S.search.q = ''; renderSearch(); el.searchInput.focus(); });
$('#search-cancel').addEventListener('click', () => closeSearch());
addEventListener('keydown', (e) => {
  if (e.key === '/' && S.screen === 'main' && !S.search.active && !viewer.isOpen && !isSheetOpen() && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); openSearch(); }
});

// ── misc ─────────────────────────────────────────────────────────────────────
let toastTimer = 0;
function toast(a, b) {
  el.toast.replaceChildren(...(b === undefined ? [a] : [a, b]).map((x) => (x instanceof Node ? x : document.createTextNode(String(x)))));
  el.toast.classList.toggle('top', viewer.isOpen || isSheetOpen()); // stay clear of the sheet
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), 1700);
}

addEventListener('pageshow', (e) => { if (e.persisted) onResume(); });
addEventListener('online', () => { if (S.screen === 'main' && canSend()) up().retry(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) onResume();
  if (!document.hidden && S.screen === 'main' && !S.redirecting && canSend()) up().run();   // uploads left from last time
  if (document.hidden || S.redirecting || S.screen !== 'main' || !S.snap) return;
  if (Date.now() - S.snap.lastSync > 5 * 60_000 && (S.mode === 'demo' || tokenValid())) runSync({ background: true });
});
