// Perch — boot, screens, sync orchestration, folders/search/more sheets.
import { $, h, clamp, debounce, lsGet, lsSet, timeAgo, fmtBytes, rubberband, reducedMotion, nextFrame, sleep } from './util.js';
import { I } from './icons.js';
import { kv, swkv, wipeAll } from './store.js';
import { hasClientId, signIn, consumeRedirect, tokenValid, token, getAuth, canTrySilent, expireToken, signOut, redirectUri, tokenLeft, rememberAccount, RENEW_AHEAD, NEEDS_USER, renewInFrame, frameRenewAllowed, canWrite } from './auth.js';
import { extractUrl, saveLink, saveDelete, newStem, recentLinks, siteOf } from './inbox.js';
import { createUploader, stash, stashStream, waiting, clearWaiting } from './uploads.js';
import { collectPending, notInLibrary } from './pending.js';
import { takePairing, paired, ping, pingProblem, startDownload, getJob, finishJob, fetchFile, pushCookies, clearCookies, activeJobs, rememberJob, forgetJob, siteNames, BridgeError, canUpload } from './bridge.js';
import { quickShare, hideQuickCard } from './quick.js';
import { createDrive, fetchBackend } from './drive.js';
import { createMockDrive, MOCK_CACHE } from './mockdrive.js';
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
  pending: [],             // videos sent from the phone that Eagle hasn't added yet (js/pending.js)
  pendingStems: new Set(),
  hidden: {},              // items deleted on this phone, until Eagle has trashed them: id → { stem, name, at, sent }
};
window.__perch = S; // handy for debugging in devtools
const SHARE_KEY = 'perch.share';     // links shared to Perch, kept until saved or downloaded (survive a sign-in redirect): [{ url, t, pc, job }]
const SHARE_QUEUE_TTL = 24 * 60 * 60_000;
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
    if (fileId.startsWith('local:')) return localSrc(fileId.slice(6), size);
    if (S.swOk && navigator.serviceWorker?.controller && !mockUpload(fileId)) return new URL(`media/${encodeURIComponent(fileId)}`, document.baseURI).href;
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
    if (!S.swOk || !navigator.serviceWorker?.controller || !fileId || fileId.startsWith('local:') || mockUpload(fileId)) return;
    if (size > 30 * 1024 * 1024) return;
    const c = navigator.connection;
    if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return;
    // Resolves once the service worker has the whole file (the viewer prefetches one at a time); never hangs.
    return fetch(new URL(`media/${encodeURIComponent(fileId)}`, document.baseURI), { headers: { 'X-Perch-Prefetch': '1', 'X-Perch-Size': String(size || 0) }, signal: AbortSignal.timeout(60000) }).catch(() => {});
  },
  lastError: () => (S.mode === 'drive' && !tokenValid() ? { name: 'AuthError' } : null),
  /** A video failed: was it the token? Asks the service worker's media route for one byte. */
  async authFailed(fileId) {
    if (S.mode !== 'drive' || fileId.startsWith('local:')) return false;
    if (!tokenValid()) return true;
    if (!S.swOk) return false;
    try {
      const r = await fetch(new URL(`media/${encodeURIComponent(fileId)}`, document.baseURI), { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      return r.status === 401;
    } catch { return false; }
  },
  refreshing: () => !!S.redirecting,
};

/** A video uploaded in demo mode lives in the mock Drive, which the service worker can't see. */
const mockUpload = (fileId) => !!(S.mock && S.mock.hasBytes && S.mock.hasBytes(fileId));

/** A video sent to Eagle that's still on this phone (not uploaded yet): play the phone's own copy. */
async function localSrc(stem, size) {
  const w = (await waiting()).find((x) => x.id === stem);
  if (w) return URL.createObjectURL(await w.blob());
  // It finished uploading meanwhile: play it from Drive instead.
  await refreshPending({ network: true });
  const p = S.pending.find((it) => it.pending.stem === stem && !it.f.main.startsWith('local:'));
  if (p) return media.src(p.f.main, { size });
  throw new Error('This video is no longer on the phone');
}

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
  onClosed: () => {
    if (S.renewWhenIdle && !S.shareOpen) { S.renewWhenIdle = false; renewSoon('idle'); }
    if (S.snapLater) {
      // A sync finished while the viewer was open: the grid changes now, not under the viewer.
      const snap = S.snapLater;
      S.snapLater = null;
      S.deletesDirty = S.pendingDirty = false;
      applySnapshot(snap, { keepScroll: true });
      return;
    }
    if (S.deletesDirty) { S.deletesDirty = false; S.pendingDirty = false; rebuildModel(); }
    if (S.pendingDirty) { S.pendingDirty = false; showPending(); }
  },
  onDelete: (it) => deleteItem(it),
});

function openViewer(i, tile) {
  const rect = tile ? tile.getBoundingClientRect() : grid.tileRect(i);
  viewer.open(S.list, i, rect && { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
}

// ── boot ─────────────────────────────────────────────────────────────────────
boot().catch((e) => { console.error(e); toast(e.message || 'Something went wrong'); });

async function boot() {
  const swReady = registerServiceWorker();
  // Installed apps get persistent storage: videos not uploaded yet and the library cache survive storage pressure.
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not offered */ }
  const params = new URLSearchParams(location.search);
  const sharedLink = takeSharedLink(params);
  // The phone downloader's installer opens Perch with #bridge=<token>. Asking it right away also brings up
  // Chrome's one-time "allow access to this device" prompt now, in context.
  if (takePairing()) setTimeout(() => { toast('Phone downloader connected'); ping(); }, 400);
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
  // A link shared from another app: hand it on and close Perch (js/quick.js). Anything it can't do quietly
  // (signed out, no write permission, downloader off or old) leaves the link in the share queue for the normal flow below.
  if (sharedLink && !red && mode && mode.mode === 'drive') await quickShareAndClose(sharedLink);
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
  // A cold start loads Google's page slowly: give the frame longer than a renew mid-session gets.
  if (!red && tokenLeft() <= RENEW_AHEAD) await renewQuiet('start', { timeout: 7000 });
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
      if (k === 'perch.lib.drive' || k === RESUME_KEY || k.startsWith('perch.view.drive.') || k.startsWith('perch.pasted.drive') || k.startsWith('perch.inbox.') || k.startsWith('perch.pending.') || k.startsWith('perch.lastSync.drive')) localStorage.removeItem(k);
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
      const wasLost = S.authLost;
      S.authLost = false;
      if (S.screen === 'main' && /Reconnect|Refreshing|refresh sign-in|Offline/.test(el.notice.textContent || '')) setNotice(null);
      scheduleRenew();
      console.info(`[perch] token renewed in the background (${reason})`);
      // Sign-in was lost meanwhile: catch up on what was missed.
      if (wasLost && S.screen === 'main' && reason !== 'start') { runSync({ background: true }); refreshPending(); }
      if (uploader && S.screen === 'main') uploader.retrySoft();   // uploads that failed on the old token
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
  if (videoPlaying() || S.shareOpen) { S.renewWhenIdle = true; return false; }   // never interrupt playback or a link being typed
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
    setTimeout(() => { refreshPending({ network: false }); refreshPending(); }, 0);
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
async function showLibraries({ noAuto = false } = {}) {
  showScreen('libs');
  el.libList.replaceChildren();
  el.libsSub.textContent = 'Looking for Eagle libraries…';
  try {
    S.libs = withPasted(await discoverLibraries(S.drive));
  } catch (e) {
    return handleFatal(e, { noAuto });
  }
  if (S.libs.length === 1 && !noAuto) return openLibrary(S.libs[0]);
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
// A sync that changed nothing doesn't rewrite the snapshot; only its time is kept, here.
const lastSyncKey = (libId) => `perch.lastSync.${S.modeKey}.${libId}`;

async function openLibrary(lib) {
  S.lib = lib;
  S.hidden = lsGet(hiddenKey(lib.id), {}) || {};
  S.pending = [];
  S.pendingSig = '';
  S.pendingStems = new Set();
  lsSet(`perch.lib.${S.modeKey}`, lib);
  S.view = lsGet(`perch.view.${S.modeKey}.${lib.id}`, { type: 'all' });
  S.snap = null;
  S.snapLater = null;
  S.model = null;
  setThumbSource(S.drive);
  const snap = await kv.get(snapKey(lib.id)).catch(() => null);
  if (snap) snap.lastSync = Math.max(snap.lastSync || 0, Number(lsGet(lastSyncKey(lib.id))) || 0);
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
    const base = S.snapLater || S.snap;   // a snapshot waiting for the viewer to close is the newest
    const { snap, stats } = await syncLibrary(S.drive, lib, full ? null : base, { full, onProgress: first ? (p) => { if (current()) firstSyncProgress(p); } : () => {} });
    if (!current()) return;
    console.info('[perch] sync', stats);
    S.lastStats = stats;
    const changed = first || full || stats.fetched > 0 || stats.removed > 0 || !base || snap.metaModified !== base.metaModified;
    // Write the (large) snapshot only when something in it changed; otherwise just note the time.
    const dirty = changed || snap.tagsModified !== base.tagsModified || stats.skipped !== Object.keys(base.skipped || {}).length;
    if (dirty) await kv.set(snapKey(lib.id), snap).catch((e) => console.warn('[perch] could not cache library', e));
    else lsSet(lastSyncKey(lib.id), snap.lastSync);
    if (first) {
      applySnapshot(snap, { reveal: true });
      showScreen('main');
    } else if (changed && viewer.isOpen) {
      S.snapLater = snap;   // applied when the viewer closes (the grid mustn't change under it)
    } else if (changed) {
      S.snapLater = null;
      applySnapshot(snap, { keepScroll: true });
    } else if (S.snapLater) {
      S.snapLater = snap;
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
      if (S.screen === 'main') refreshPending();
    }
  }
}

function showSyncError(e) {
  el.syncBar.parentElement.classList.remove('indeterminate');
  el.syncBar.style.transform = 'scaleX(0)';
  el.syncCount.replaceChildren(
    h('span', null, e.message || 'Sync failed'), h('br'),
    h('button', { class: 'btn-quiet', type: 'button', style: { height: '40px', marginTop: '8px' }, onclick: () => { showSyncScreen(S.lib); runSync({ first: true }); } }, 'Try again'),
    h('button', { class: 'btn-quiet', type: 'button', style: { height: '40px', marginTop: '8px', marginLeft: '12px' }, onclick: () => showLibraries({ noAuto: true }) }, 'Libraries'));
}

function handleFatal(e, { noAuto = false } = {}) {
  if (e.name === 'AuthError') { onAuthExpired().then((ok) => { if (ok) { if (mayRetryAuth()) showLibraries({ noAuto }); } else if (!S.redirecting) showOnboarding(); }); return; }
  el.libsSub.replaceChildren(h('span', null, e.message || 'Something went wrong'), h('br'),
    h('button', { class: 'btn-quiet', type: 'button', style: { height: '40px', marginTop: '8px' }, onclick: () => showLibraries({ noAuto }) }, 'Try again'));
}

function onAuthLost() {
  if (S.mode !== 'drive') return;
  S.authLost = true;
  expireToken();
  // Offline, Google's page can't load: say so; back online it renews quietly (see the 'online' listener).
  if (!navigator.onLine) { setNotice('Offline · saved library'); return; }
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
  pruneHidden(snap);
  S.model = libraryModel(snap);
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
  S.list = searching ? m.search(m.visible, S.search.q, S.search.tags) : withPending(m.list(S.view));
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
    if (S.model.isLocked(node.id)) {
      // A locked folder inside: ask for that one next, by name.
      const next = S.model.folderPath(node.id).find((f) => f.password && !S.unlocked.has(f.id)) || node;
      input.value = '';
      err.textContent = '';
      const t = sheet.el.querySelector('.sheet-title');
      if (t) t.textContent = next.name;
      const sub = sheet.el.querySelector('.sheet-sub');
      if (sub) sub.textContent = `Now enter the password for “${next.name}”`;
      hint.textContent = next.tips ? `Hint: ${next.tips}` : '';
      hint.hidden = !next.tips;
      return;
    }
    await closeSheet();
    selectView({ type: 'folder', id: node.id });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const lockOwner = S.model.folderPath(node.id).find((f) => f.password && !S.unlocked.has(f.id)) || node;
  const hint = h('div', { class: 'hint', hidden: !lockOwner.tips }, lockOwner.tips ? `Hint: ${lockOwner.tips}` : '');
  const sheet = openSheet({
    title: lockOwner.name,
    sub: 'This folder is locked in Eagle.',
    body: h('div', { class: 'form' }, input, hint, err,
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
  const bridgeMeta = h('span', { class: 'meta' }, paired() ? '' : 'Set up');
  if (paired()) ping().then((info) => { bridgeMeta.textContent = info ? 'On' : 'Off'; });
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
      ANDROID || paired() ? h('button', { class: 'row', type: 'button', onclick: async () => { await sheet.close(); openPhoneDownloader(); } },
        h('span', { class: 'ico', html: I.phone }), h('span', { class: 'label' }, 'Phone downloader'), bridgeMeta) : null,
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

// ── videos on their way to Eagle ─────────────────────────────────────────────
// What the phone sent (a phone download, a shared or picked video) shows in "All" like any other reference
// right away, and plays from the phone's copy or from Drive, until Eagle on the computer has added it.

/** "All" starts with them (they're the newest); never in folders or search, never next to the real item. */
function withPending(list) {
  if (S.view.type !== 'all' || !S.pending.length || !S.model) return list;
  return [...notInLibrary(S.pending.filter((it) => !S.hidden[it.id]), S.model.items), ...list];
}

/**
 * Look again at what was sent: what's still on the phone and what waits in the Drive inbox. On launch,
 * resume, each sync and each finished upload. One at a time; a call meanwhile runs once more afterwards.
 * `network: false` only looks at the phone (and the last Drive answer): instant, for a new file.
 */
function refreshPending({ network = true } = {}) {
  if (!S.lib || !S.drive || S.redirecting) return Promise.resolve();
  if (S.pendingP) { S.pendingAgain = S.pendingAgain || (network ? 'net' : 'local'); return S.pendingP; }
  const lib = S.lib;
  if (network) flushDeletes();
  S.pendingP = (async () => {
    const r = await collectPending({
      drive: S.drive, modeKey: S.modeKey, libName: lib.name, uploads: uploader ? uploader.list() : [],
      network: network && (S.mode === 'demo' || tokenValid()), token: S.mode === 'drive' ? token() : '',
    });
    if (S.lib !== lib) return;
    settleDeletes(r);
    // Eagle added one: bring the real item in (it takes the pending tile's place).
    if (r.done.some((stem) => S.pendingStems.has(stem))) runSync({ background: true });
    S.pendingStems = new Set(r.items.map((it) => it.pending.stem));
    setPending(r.items);
    // New thumbnails (Drive's, or frames from the phone's copy) arrive in the background: show them then.
    r.thumbs.then((got) => { if (got && S.lib === lib) refreshPending({ network: false }); });
  })().catch((e) => console.info('[perch] pending:', e.message)).finally(() => {
    S.pendingP = null;
    const again = S.pendingAgain;
    S.pendingAgain = false;
    if (again) refreshPending({ network: again === 'net' });
  });
  return S.pendingP;
}

function setPending(items) {
  const sig = items.map((it) => [it.id, it.f.main, it.f.thumb, it.w, it.h, it.duration].join(':')).join('|');
  if (sig === S.pendingSig) {
    // Same tiles: only the status moved (an upload's progress, the info note).
    const now = new Map(items.map((it) => [it.id, it]));
    for (const it of S.pending) if (now.has(it.id)) it.pending = now.get(it.id).pending;
    grid.refreshMarks();
    return;
  }
  S.pending = items;
  S.pendingSig = sig;
  showPending();
}

function showPending() {
  if (viewer.isOpen) { S.pendingDirty = true; return; }   // keep the viewer's swipe order; applied on close
  if (S.screen === 'main' && S.model && !S.search.active && S.view.type === 'all') render({ keepScroll: true });
}

/**
 * The upload queue moved: a new file on the phone shows at once, a failed one says so; progress moves the
 * tile's hairline. Runs at most once a frame (it's called on every upload progress event).
 */
let trackFrame = 0, trackLatest = [];
function trackUploads(items) {
  trackLatest = items;
  if (!trackFrame) trackFrame = requestAnimationFrame(() => { trackFrame = 0; trackNow(trackLatest); });
}
function trackNow(items) {
  const ids = items.map((u) => `${u.id}:${u.status}`).join(',');
  if (ids !== S.uploadIds) { S.uploadIds = ids; refreshPending({ network: false }); }
  const byId = new Map(items.map((u) => [u.id, u]));
  for (const it of S.pending) {
    const u = byId.get(it.pending.stem);
    if (u && it.pending.upload) it.pending.upload = u.status === 'uploading' ? { sent: u.sent || 0, size: u.size || it.size } : { sent: 0, size: it.size };
  }
  grid.refreshMarks();
}

// ── delete from the phone ────────────────────────────────────────────────────
// Perch can't touch the Eagle library (Drive is read-only for it), so a delete travels like a link: after the
// Undo window a small request goes into the Perch Inbox and Video Grabber moves the item to Eagle's Trash.
// Meanwhile the item stays hidden here (S.hidden, kept per library) until a sync no longer has it. A video
// sent from the phone that Eagle hasn't added yet never reaches Eagle: its upload stops, or its files in the
// inbox go to Drive's bin.
const UNDO_MS = 5000;
const DELETE_KEEP = 30 * 864e5;                 // never processed by Eagle: show the item again after this
const hiddenKey = (libId) => `perch.deleted.${S.modeKey}.${libId}`;
const undoTimers = new Map();                   // item id → timer of its Undo window

/** The library model without what was deleted here, so All, folders, counts and search agree. */
function libraryModel(snap) {
  const items = snap.items.filter((it) => !S.hidden[it.id]);
  return new Library(items.length === snap.items.length ? snap : { ...snap, items });
}

function rebuildModel() {
  if (!S.snap) return;
  S.model = libraryModel(S.snap);
  S.model.setUnlocked(S.unlocked);
  S.pendingDirty = false;
  render({ keepScroll: true });
}

function saveHidden() { if (S.lib) lsSet(hiddenKey(S.lib.id), S.hidden); }

/** After a sync: what Eagle has trashed is gone from the library, so it needn't be hidden any more. */
function pruneHidden(snap) {
  const ids = new Set(snap.items.map((it) => it.id));
  let changed = false;
  for (const [id, e] of Object.entries(S.hidden)) {
    if (e.pending || undoTimers.has(id)) continue;   // phone videos are settled in settleDeletes()
    if (!ids.has(id) || Date.now() - e.at > DELETE_KEEP) { delete S.hidden[id]; changed = true; }
  }
  if (changed) saveHidden();
}

function deleteItem(it) {
  if (!canSend()) { askWrite({ files: false }); return; }   // Google's OK to write to Drive first, as for Save to Eagle
  const id = it.id;
  const entry = { name: it.name, at: Date.now(), sent: false };
  if (it.pending) {
    const local = it.f.main.startsWith('local:');
    Object.assign(entry, { pending: it.pending.stem, local, video: local ? '' : it.f.main, req: it.pending.req || '' });
  } else entry.stem = newStem();
  const L = viewer.isOpen ? viewer.items : S.list;
  const i = L.findIndex((x) => x.id === id);
  const nextId = L[i + 1]?.id, prevId = L[i - 1]?.id;
  S.hidden[id] = entry;
  saveHidden();
  rebuildModel();
  if (viewer.isOpen) {
    let j = S.list.findIndex((x) => x.id === nextId);
    if (j < 0) j = S.list.findIndex((x) => x.id === prevId);
    if (j < 0) j = Math.min(i, S.list.length - 1);
    viewer.reload(S.list, j);
  }
  clearTimeout(undoTimers.get(id));
  undoTimers.set(id, setTimeout(() => { undoTimers.delete(id); flushDeletes(); }, UNDO_MS));
  toast('Deleted', undefined, { action: 'Undo', onAction: () => undoDelete(id), ms: UNDO_MS });
}

function undoDelete(id) {
  const e = S.hidden[id];
  if (!e || e.sent || !undoTimers.has(id)) return;   // too late: already on its way
  clearTimeout(undoTimers.get(id));
  undoTimers.delete(id);
  delete S.hidden[id];
  saveHidden();
  rebuildModel();
  if (viewer.isOpen) {
    const j = S.list.findIndex((x) => x.id === id);
    if (j >= 0) viewer.reload(S.list, j);
  }
}

/**
 * Send what's past its Undo window and not sent yet. Retried at launch, on resume, when back online and
 * after each sync (with refreshPending); a failure (offline, sign-in expired) just waits for the next one.
 */
let flushing = null;
function flushDeletes() {
  if (flushing || !S.lib || !S.drive || S.redirecting || !canSend()) return flushing || Promise.resolve();
  const lib = S.lib, hid = S.hidden, key = hiddenKey(lib.id);
  const now = Date.now();
  const due = [];
  for (const [id, e] of Object.entries(hid)) {
    if (e.sent || undoTimers.has(id)) continue;
    if (now - e.at >= UNDO_MS) due.push([id, e]);
    else undoTimers.set(id, setTimeout(() => { undoTimers.delete(id); flushDeletes(); }, UNDO_MS - (now - e.at)));   // left from before a reload
  }
  if (!due.length) return Promise.resolve();
  flushing = (async () => {
    for (const [id, e] of due) {
      try {
        if (e.pending) await removePending(e);
        else await saveDelete(S.drive, S.modeKey, { stem: e.stem, item: id, name: e.name, library: lib });
        if (hid[id] === e) { e.sent = true; lsSet(key, hid); }
      } catch (err) {
        console.info('[perch] delete not sent yet:', err.message);
        if (err.name === 'AuthError' || (err.name === 'DriveError' && (err.status === 0 || err.status === 403))) break;
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

/** A phone video deleted before Eagle added it: stop it on the phone, or bin its files in the inbox. */
async function removePending(e) {
  const p = S.pending.find((x) => x.pending.stem === e.pending);
  const local = p ? p.f.main.startsWith('local:') : e.local;
  if (local) {
    const uploaded = await up().cancel(e.pending);
    if (uploaded) await binFile(uploaded);
    return;
  }
  for (const id of [p ? p.f.main : e.video, p ? p.pending.req : e.req]) if (id) await binFile(id);
}
const binFile = (id) => S.drive.trash(id).catch((err) => { if (!(err.name === 'DriveError' && err.status === 404)) throw err; });   // 404: already gone

/** What the inbox says about the deletes: Eagle couldn't do one → show the item again. */
function settleDeletes(r) {
  let changed = false;
  const failed = [];
  if (r.deletes) {
    const byStem = new Map(r.deletes.map((d) => [d.stem, d]));
    for (const [id, e] of Object.entries(S.hidden)) {
      if (e.pending || !e.sent) continue;
      if (byStem.get(e.stem)?.status === 'error') { delete S.hidden[id]; failed.push(e.name); changed = true; }
    }
  }
  if (r.net) {
    const live = new Map(r.items.map((it) => [it.pending.stem, it]));
    let again = false;
    for (const [id, e] of Object.entries(S.hidden)) {
      if (!e.pending) continue;
      const it = live.get(e.pending);
      if (e.sent && !it) { delete S.hidden[id]; changed = true; }                    // gone from the phone and the inbox
      else if (e.sent && !it.f.main.startsWith('local:') && (e.tries || 0) < 5) {
        // It reached the inbox just as it was deleted: bin it there too.
        Object.assign(e, { sent: false, local: false, video: it.f.main, req: it.pending.req || '', tries: (e.tries || 0) + 1 });
        changed = again = true;
      } else if (Date.now() - e.at > DELETE_KEEP) { delete S.hidden[id]; changed = true; }
    }
    if (again) setTimeout(flushDeletes, 0);
  }
  if (!changed) return;
  saveHidden();
  for (const name of failed) toast(`Couldn’t delete “${name}” in Eagle`);
  if (failed.length) { if (viewer.isOpen) S.deletesDirty = true; else rebuildModel(); }
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
      onChange: (items) => { for (const fn of uploadListeners) fn(items); trackUploads(items); },
      onSaved: (it) => { if (!S.shareOpen) toast('Sent to Eagle', it.name ? ` · ${it.name}` : ''); refreshPending(); },
    });
    S.uploader = uploader;   // for devtools
  }
  return uploader;
}

/** First upload: Google asks once to let Perch create files (it only ever sees files it made). */
function askWrite({ files = true } = {}) {
  if (files) lsSet(SHARE_FILES_KEY, Date.now());   // back from Google: carry on with the shared files
  saveUiState();
  S.redirecting = true;
  signIn({ write: true });
}

/**
 * The share sheet opened Perch: a link (?share_url / share_text / share_title) or files (?shared=n, kept by the service worker).
 * Returns the link when one was queued (never for files).
 */
function takeSharedLink(params) {
  const keys = ['share_url', 'share_text', 'share_title'];
  if (![...keys, 'shared'].some((k) => params.has(k))) return '';
  const shared = params.get('shared');
  const url = extractUrl(...keys.map((k) => params.get(k)));
  for (const k of [...keys, 'shared']) params.delete(k);
  const rest = params.toString();
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
  if (shared === 'failed') setTimeout(() => toast('Couldn’t receive what you shared'), 500);
  else if (shared && shared !== 'empty') lsSet(SHARE_FILES_KEY, Date.now());
  else if (url) { queuePut(url, { fresh: true }); return url; }   // joins any link still waiting: several shares in a row all count
  else setTimeout(() => toast('There was no link in what you shared'), 500);
  return '';
}

/**
 * Quick share: the card, the hand-over, then close Perch so Android returns to the app the link came from. A browser
 * that won't let the page close itself leaves it open: then it carries on into the normal app, quietly (a toast, no Save
 * sheet; the watcher and the tiles work as always).
 */
async function quickShareAndClose(url) {
  const out = await quickShare(url, { queueDrop });
  if (!out) return;
  await sleep(900);
  try { window.close(); } catch { /* not allowed */ }
  await sleep(400);
  hideQuickCard();   // still here: the close was blocked
  S.quickNote = out.toast;
}

// ── the share queue: links shared to Perch that aren't saved or downloaded yet ──────────────────────────
// Kept in localStorage until the phone has the file or the link is saved for the computer, so nothing is
// lost to a failed save, a sign-in redirect or Perch being closed. Entry: { url, t, pc, job, fresh }
// (pc: goes to the computer; job: the phone downloader's job for it; fresh: not looked at yet).
function shareQueue() {
  let q = lsGet(SHARE_KEY);
  if (q && !Array.isArray(q)) q = [q];   // one link, as saved before the queue
  return (q || []).filter((e) => e && e.url && Date.now() - (e.t || 0) < SHARE_QUEUE_TTL);
}
function saveQueue(q) { lsSet(SHARE_KEY, q.length ? q : null); }
function queuePut(url, patch = {}) {
  const q = shareQueue();
  const e = q.find((x) => x.url === url);
  if (e) Object.assign(e, patch); else q.push({ url, t: Date.now(), ...patch });
  saveQueue(q);
}
function queueDrop(url) { saveQueue(shareQueue().filter((x) => x.url !== url)); }
const inQueue = (url) => shareQueue().some((x) => x.url === url);

/** Something was just shared: "All" is where its tile shows. */
function showAll() {
  if (!S.model || S.screen !== 'main') return;
  if (S.search.active || S.view.type !== 'all') selectView({ type: 'all' });
}

function handleSharedLink() {
  if (S.screen !== 'main' || S.redirecting) return;
  if (canSend()) up().run();
  const files = lsGet(SHARE_FILES_KEY);
  if (files) lsSet(SHARE_FILES_KEY, null);
  const newFiles = !!files && Date.now() - files < SHARE_TTL;
  const q = shareQueue();
  const fresh = q.filter((e) => e.fresh);
  if (fresh.length) { for (const e of q) delete e.fresh; }
  saveQueue(q);   // (also drops links too old to matter)
  if (newFiles || fresh.length) showAll();
  // Links download on this phone when the phone downloader is set up, otherwise they're saved for the computer.
  if (paired()) resumeWatcher({ share: true });
  if (canSend()) for (const e of q) if (e.pc || !paired()) sendToPc(e.url, '');
  if (S.shareOpen) return;
  if (S.quickNote) { toast(S.quickNote); S.quickNote = ''; return; }   // quick share that couldn't close: nothing to open
  // Show what's happening: new files or links, links waiting for Google's OK, or a download still going from before.
  if (newFiles || fresh.length || q.some((e) => e.pc || !paired()) || (paired() && activeJobs().some((j) => Date.now() - j.t < SHARE_TTL))) openSaveLink();
}

// ── phone downloads, watched here whether the Save sheet is open or not ─────────────────────────────────
// Each download in the phone downloader is an entry; the watcher polls it, copies the finished file into the
// phone's storage, queues the upload and refreshes the tiles. The Save sheet only shows these entries.
// Entry: { key, url, id, lib, state, text, p, title, kept, preview } with state 'start' | 'run' | 'copy' |
// 'ready' | 'kept' (another Perch window has it) | 'error' (the link can't work) | 'retry' (copying failed:
// the job is kept until the user retries or gives up).
const W = { list: [], n: 0, listeners: new Set() };
const wEmit = (ev = { type: 'list' }) => { for (const fn of W.listeners) fn(ev); };
const wSet = (e, patch) => { Object.assign(e, patch); wEmit(); };
const ENDED = new Set(['ready', 'kept', 'error']);
function wDrop(e) {
  e.state = 'gone';
  W.list = W.list.filter((x) => x !== e);
  wEmit();
}

let bridgeCheck = null;
/** The phone downloader's status, asked once for the watcher and the sheet alike (fresh after a few seconds). */
function bridgeStatus() {
  if (!bridgeCheck || Date.now() - bridgeCheck.t > 4000) bridgeCheck = { t: Date.now(), p: paired() ? ping() : Promise.resolve(null) };
  return bridgeCheck.p;
}

/** Downloads remembered from before (and shared links not started yet): watch them. On launch and resume. */
function resumeWatcher({ share = false } = {}) {
  if (!paired()) return;
  for (const j of activeJobs()) watchJob(j);
  const jobs = new Set(activeJobs().map((j) => j.id));
  for (const e of shareQueue()) {
    if (e.pc) continue;
    if (e.job && !jobs.has(e.job)) { if (!W.list.some((x) => x.id === e.job)) queueDrop(e.url); continue; }   // handled before Perch closed
    if (!e.job) watchLink(e.url, { cancellable: share });
  }
}

/** Download a link on this phone. `cancellable`: closing the sheet before the job exists cancels it. */
function watchLink(url, { cancellable = false } = {}) {
  const same = W.list.find((x) => x.url === url && !ENDED.has(x.state));
  if (same) return same;
  const e = { key: `w${++W.n}`, url, id: '', lib: S.lib, state: 'start', text: 'Starting…', p: null, title: '', cancellable };
  W.list.push(e);
  wEmit();
  startJob(e);
  return e;
}

function watchJob({ id, url, lib }) {
  if (W.list.some((x) => x.id === id)) return;
  // The library it was shared into, not whichever is open now.
  const e = { key: `w${++W.n}`, url, id, lib: lib ? { name: lib } : S.lib, state: 'run', text: 'Starting…', p: null, title: '' };
  W.list.push(e);
  wEmit();
  pollJob(e);
}

async function startJob(e) {
  const info = await bridgeStatus();
  if (e.cancelled) { wDrop(e); queueDrop(e.url); return; }   // the sheet was closed first: the user didn't want it
  if (e.state === 'gone') return;
  if (!info) { giveUp(e, pingProblem() === 'auth' ? 'auth' : 'off'); return; }
  try {
    ({ id: e.id } = await startDownload(e.url));
  } catch (err) {
    giveUp(e, err.code === 'auth' ? 'auth' : err.code === 'off' ? 'off' : 'job', err.message);
    return;
  }
  e.cancellable = false;
  if (W.list.some((x) => x !== e && x.id === e.id)) { wDrop(e); return; }   // the bridge already had this link going
  rememberJob(e.id, e.url, e.lib ? e.lib.name : '');
  if (inQueue(e.url)) queuePut(e.url, { job: e.id });
  pollJob(e);
}

async function pollJob(e) {
  let misses = 0;
  for (;;) {
    if (e.state === 'gone') return;
    let j;
    try {
      j = await getJob(e.id);
      misses = 0;
    } catch (err) {
      if (e.state === 'gone') return;
      if (err.code === 'notfound') {
        // Gone from the bridge: kept by another Perch window (it forgets the job once it has the file), or lost.
        if (activeJobs().some((x) => x.id === e.id)) giveUp(e, 'gone'); else keptElsewhere(e);
        return;
      }
      if (err.code === 'auth') { giveUp(e, 'auth'); return; }
      if (++misses >= 6) { giveUp(e, 'off'); return; }
      await sleep(700);
      continue;
    }
    if (e.state === 'gone') return;
    if (j.title) e.title = j.title;
    if (j.status === 'done') {
      // A version-2 bridge that was handed a Drive token uploads the file itself. Never both: while it is on its way
      // we wait; only when there's no upload (or it failed, leaving the files) is the file copied in.
      const up = j.upload && j.upload.state;
      if (up === 'done') { uploadedByBridge(e, j); return; }
      if (up === 'waiting' || up === 'uploading') {
        wSet(e, { state: 'run', text: 'Sending to Drive…', p: up === 'uploading' && j.upload.progress != null ? j.upload.progress : null });
        await sleep(document.hidden ? 3000 : 700);
        continue;
      }
      claimJob(e, j);
      return;
    }
    if (j.status === 'error') { jobFailed(e, j); return; }
    const [text, p] = jobText(j);
    wSet(e, { state: 'run', text, p });
    await sleep(document.hidden ? 3000 : 700);
  }
}

/** The phone couldn't: save the link for the computer instead (or keep it for that). */
function giveUp(e, reason, detail = '') {
  if (e.state === 'gone') return;
  const why = reason === 'off' ? 'Phone downloader is off.'
    : reason === 'auth' ? 'Phone downloader needs setting up again.'
    : reason === 'gone' ? 'The download on the phone was lost.'
    : reason ? `${String(detail || 'Couldn’t download it on this phone').replace(/[.!]?\s*$/, '.')}` : '';
  if (inQueue(e.url)) queuePut(e.url, { pc: true, job: null });   // before the job is forgotten
  if (e.id) { forgetJob(e.id); finishJob(e.id).catch(() => {}); }
  wDrop(e);
  if (reason === 'off' || reason === 'auth') { bridgeCheck = null; wEmit({ type: 'down' }); }
  sendToPc(e.url, why, { ask: !why });
}

function jobFailed(e, j) {
  // Links that can never work: just say so. Anything else may still work on the computer.
  if (j.code !== 'unsupported' && j.code !== 'novideo') { giveUp(e, 'job', j.error); return; }
  forgetJob(e.id);
  finishJob(e.id).catch(() => {});
  queueDrop(e.url);
  wSet(e, { state: 'error', text: j.error || 'There’s no video to save here.', p: null });
}

function keptElsewhere(e) {
  queueDrop(e.url);
  wSet(e, { state: 'kept', text: 'Saved in another Perch window', p: 1 });
}

/** The bridge put the file and its request in the Drive inbox itself: nothing to copy in, the tile comes from the inbox. */
function uploadedByBridge(e, j) {
  forgetJob(e.id);
  finishJob(e.id).catch(() => {});   // (a second Perch window does the same: harmless)
  queueDrop(e.url);
  wSet(e, { state: 'ready', title: j.title || '', sent: (j.upload.stems || []).length || 1, p: 1 });
  refreshPending();
  if (!S.shareOpen) toast('Sent to Eagle');
}

/** The download is done: copy it in (once, even with two Perch windows), then it uploads like any phone video. */
async function claimJob(e, j) {
  e.job = j;
  wSet(e, { state: 'copy', text: 'Almost done', p: null });
  try {
    const kept = await claimOnce(e, j, (got, total) => wSet(e, { text: `Almost done · ${total ? Math.floor((100 * got) / total) : 0}%`, p: total ? got / total : null }));
    if (e.state === 'gone') return;
    if (!kept) { keptElsewhere(e); return; }
    queueDrop(e.url);
    wSet(e, { state: 'ready', title: j.title || kept[0].name, p: 1 });
  } catch (err) {
    if (e.state === 'gone') return;
    if (err.code === 'novideo') { jobFailed(e, { code: 'novideo', error: err.message }); return; }
    // Copying it in failed (cut off, or the phone is full): the downloader keeps its copy for another try.
    console.warn('[perch] couldn’t copy the download in:', err.message);
    wSet(e, { state: 'retry', text: err.name === 'QuotaExceededError' ? 'Not enough space on this phone' : 'Couldn’t copy it from the phone downloader', p: null });
  }
}

/** Retry a download whose copy failed (asks the bridge again, then copies). */
function retryJob(e) {
  if (e.state !== 'retry') return;
  wSet(e, { state: 'run', text: 'Starting…', p: null });
  pollJob(e);
}

/**
 * The installed app and a browser tab may both be watching the same job: only one copies it in. The other
 * waits its turn and then finds the job already kept (null).
 */
function claimOnce(e, job, onProgress) {
  const mine = () => (activeJobs().some((x) => x.id === e.id) ? copyIn(e, job, onProgress) : null);
  return navigator.locks ? navigator.locks.request(`perch-bridge-${e.id}`, mine) : mine();
}

/**
 * Copy a finished download from the phone downloader into the phone's storage (streamed, never in memory) and
 * queue it for Drive (the source link goes with it, so Eagle records the website). Files already copied on an
 * earlier try are kept. Only once everything is in does the downloader drop its copy.
 */
async function copyIn(e, job, onProgress) {
  const list = (job && job.files) || [];
  if (!list.length) throw new BridgeError('novideo', 'There’s no video to save here.');
  const total = list.reduce((a, f) => a + (Number(f.size) || 0), 0);
  e.kept = e.kept || {};
  const t = Date.now();
  let before = 0;
  for (const [i, f] of list.entries()) {
    if (!e.kept[f.n]) {
      e.kept[f.n] = await fetchFile(e.id, f.n, (got) => onProgress(before + got, total), f,
        (body, info) => stashStream(body, { ...info, url: e.url, library: e.lib, t: t + i }));
      refreshPending({ network: false });   // its tile shows at once
    }
    before += e.kept[f.n].size;
  }
  const kept = list.map((f) => e.kept[f.n]);
  e.preview = (kept.find((k) => /^video\//.test(k.type)) || kept[0]).blob;
  forgetJob(e.id);
  finishJob(e.id).catch(() => {});   // safely on this phone: the downloader can drop its copy
  if (canSend()) up().run();
  else if (S.shareOpen) askWrite();
  return kept;
}

/**
 * Save a link for the computer (Video Grabber downloads it). `why` says why the phone didn't. The link stays in
 * the share queue until it's saved; the sheet, when open, shows the outcome (and puts a link that couldn't be
 * saved back in the field). `ask`: may go to Google for the OK to write first.
 */
async function sendToPc(url, why = '', { ask = false } = {}) {
  if (!S.shareOpen || inQueue(url)) queuePut(url, { pc: true, job: null });
  const note = (state, msg = '') => wEmit({ type: 'pc', url, why, state, msg });
  if (!canSend()) {
    if (ask) { askWriteFor(url); return; }
    note('wait', why);
    return;
  }
  if (W.saving.has(url)) return;
  W.saving.add(url);
  note('saving');
  try {
    await saveLink(S.drive, S.modeKey, { url, library: S.lib });
    queueDrop(url);
    note('saved');
    if (!S.shareOpen) toast('Saved for your computer');
  } catch (e) {
    const scope = e.name === 'DriveError' && e.status === 403 && /insufficient|scope|permission/i.test(e.message);
    if (scope && (ask || S.shareOpen)) { askWriteFor(url); return; }
    if (e.name === 'AuthError') note('auth', 'Google sign-in expired.');
    else note('fail', e.message || 'Couldn’t save the link');
  } finally {
    W.saving.delete(url);
  }
}
W.saving = new Set();

/** First time: Google asks once to let Perch create files (it only ever sees files it made). The link waits in the queue. */
function askWriteFor(link) {
  queuePut(link, { pc: true, job: null });
  saveUiState();
  S.redirecting = true;
  signIn({ write: true });
}

const LINK_STATUS = {
  pending: 'Saved · Eagle on PC downloads it',
  queued: 'Downloading…',
  downloading: 'Downloading…',
  done: 'Added to Eagle',
  error: 'Couldn’t download',
};
const FILE_STATUS = { ...LINK_STATUS, pending: 'Uploaded · waiting for Eagle on PC', queued: 'Adding to Eagle…', downloading: 'Adding to Eagle…', error: 'Couldn’t add' };

function openSaveLink() {
  const writable = canSend();
  const libName = (S.lib?.name || '').replace(/\.library$/i, '');
  // A link that waits for the computer but can't be saved yet (Google's OK needed): ready in the field.
  const waitingPc = writable ? null : shareQueue().find((e) => e.pc || !paired());
  const input = h('input', { class: 'field', type: 'url', placeholder: 'Paste a video link', value: waitingPc ? waitingPc.url : '', autocomplete: 'off', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'send' });
  const err = h('div', { class: 'err' });
  const saveBtn = h('button', { class: 'btn-primary', type: 'button' }, writable ? 'Save link' : 'Allow & save');
  const pcBtn = h('button', { class: 'btn-quiet dl-pc', type: 'button', hidden: true, onclick: () => save() }, 'Save for computer instead');
  const reconnectBtn = h('button', { class: 'btn-quiet', type: 'button', hidden: true, onclick: () => {
    // Keep the link (it's saved once Google is back) and reconnect.
    const link = extractUrl(input.value);
    if (link) queuePut(link, { pc: true, job: null });
    reconnect();
  } }, 'Reconnect');
  const linkNote = h('p', { class: 'link-note' });
  const recent = h('div', { class: 'link-list' });
  const done = h('div', { class: 'link-done', hidden: true });
  const uploads = h('div', { class: 'link-list' });
  const phoneList = h('div', { class: 'dl-list' });
  let closed = false;
  let saving = false;   // a save is in flight: no second request from a second tap or Enter

  // ── the phone downloader (Termux): when it answers, a link downloads on this phone and the computer is
  // the quiet alternative.
  let bridgeUp = false;
  bridgeStatus().then((info) => { if (!closed) { bridgeUp = !!info; linkMode(); } });
  // The buttons wake up once there's something in the field: an empty field never says "not a link".
  const empty = () => !input.value.trim();
  function linkMode() {
    saveBtn.textContent = saving ? 'Saving…' : bridgeUp ? 'Download' : writable ? 'Save link' : 'Allow & save';
    saveBtn.disabled = pcBtn.disabled = saving || empty();
    pcBtn.hidden = !bridgeUp;
    linkNote.textContent = bridgeUp ? 'Downloads on this phone, then Eagle adds it.' : 'Video Grabber downloads it when Eagle is open on your computer.';
  }
  linkMode();

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
    try { await stash(files, { library: S.lib }); } catch (e) { toast('Couldn’t read that file'); return; }
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

  // ── a link for the computer (Video Grabber downloads it).
  function showDone(title, sub) {
    done.hidden = false;
    done.replaceChildren(h('span', { class: 'ico', html: I.check }),
      h('div', null, h('div', { class: 'link-done-title' }, title), h('div', { class: 'link-done-sub' }, sub)));
  }
  async function save(link = extractUrl(input.value)) {
    if (saving) return;
    err.textContent = '';
    reconnectBtn.hidden = true;
    if (!link) { if (!empty()) err.textContent = 'That doesn’t look like a link.'; return; }
    saving = true;
    linkMode();
    try { await sendToPc(link, '', { ask: true }); } finally { saving = false; if (!closed) linkMode(); }
  }
  /** How a link for the computer went (from this sheet or from the watcher). */
  function onPc(n) {
    if (n.state === 'saving') return;
    if (n.state === 'saved') {
      if (extractUrl(input.value) === n.url) input.value = '';
      err.textContent = '';
      reconnectBtn.hidden = true;
      if (n.why) showDone('Saved for your computer', `${n.why} Eagle downloads it the next time it’s open on your computer.`);
      else showDone('Saved', `It downloads into ${libName ? `“${libName}”` : 'Eagle'} the next time Eagle is open on your computer.`);
      loadRecent();
    } else {
      // Not saved: the link goes back in the field, ready for one tap (nothing is lost).
      input.value = n.url;
      err.textContent = n.msg || '';
      reconnectBtn.hidden = n.state !== 'auth' || S.mode !== 'drive';
    }
    linkMode();
  }

  // ── links downloading on this phone: cards over the watcher's entries
  const cards = new Map();   // entry key → card
  const blobUrls = [];
  function download() {
    err.textContent = '';
    const link = extractUrl(input.value);
    if (!link) { if (!empty()) err.textContent = 'That doesn’t look like a link.'; return; }
    input.value = '';
    linkMode();
    watchLink(link, { cancellable: true });
  }
  function card(e) {
    const head = h('div', { class: 'group-label' }, 'Downloading on this phone');
    const title = h('div', { class: 'link-title', dir: 'auto' }, siteOf(e.url));
    const meta = h('div', { class: 'link-meta' }, 'Starting…');
    const fill = h('i');
    const media = h('div', { class: 'dl-media', hidden: true });
    const retry = h('button', { class: 'link-retry', type: 'button', hidden: true, onclick: () => retryJob(e) }, 'Retry');
    const alt = h('button', { class: 'dl-alt', type: 'button', onclick: () => giveUp(e, '') }, 'Save for computer instead');
    const root = h('div', { class: 'dl indet' }, head, h('div', { class: 'dl-card' }, title, meta, h('div', { class: 'up-bar' }, fill), media, retry, alt));
    phoneList.append(root);
    return { root, head, title, meta, fill, media, retry, alt };
  }
  function paint(c, e) {
    const finished = e.state === 'ready' || e.state === 'kept';
    c.head.textContent = finished ? 'Downloaded on this phone' : e.state === 'error' ? 'Couldn’t download' : 'Downloading on this phone';
    c.title.textContent = e.title || siteOf(e.url);
    let text = e.text;
    if (e.state === 'ready') {
      const n = Object.keys(e.kept || {}).length || e.sent || 1;
      // It's already a tile in "All" (js/pending.js), playing from this phone until Eagle has it.
      text = `${n > 1 ? `${n} videos in` : 'In'} your library now · Eagle adds ${n > 1 ? 'them' : 'it'} on your computer`;
    }
    const state = finished ? 'done' : e.state === 'error' || e.state === 'retry' ? 'error' : '';
    c.meta.textContent = text;
    c.root.classList.toggle('indet', e.p == null && !state);
    c.fill.style.width = e.p == null ? '' : `${Math.round(Math.min(1, e.p) * 100)}%`;
    if (state) c.root.dataset.state = state; else delete c.root.dataset.state;
    c.alt.hidden = !(e.state === 'start' || e.state === 'run' || e.state === 'retry');
    c.retry.hidden = e.state !== 'retry';
    if (e.state === 'ready' && e.preview && !c.media.childElementCount) {
      const src = URL.createObjectURL(e.preview);
      blobUrls.push(src);
      c.media.replaceChildren(/^image\//.test(e.preview.type) ? h('img', { src, alt: '' }) : h('video', { src, controls: true, playsinline: true, preload: 'metadata' }));
      c.media.hidden = false;
    }
  }
  let cardFrame = 0;
  function renderCards() {
    cardFrame = 0;
    if (closed) return;
    for (const e of W.list) {
      let c = cards.get(e.key);
      if (!c) { c = card(e); cards.set(e.key, c); }
      paint(c, e);
    }
    const live = new Set(W.list.map((e) => e.key));
    for (const [k, c] of cards) if (!live.has(k)) { c.root.remove(); cards.delete(k); }
  }
  const onWatch = (ev) => {
    if (closed) return;
    if (ev.type === 'pc') { onPc(ev); return; }
    if (ev.type === 'down') { bridgeUp = false; linkMode(); }
    if (!cardFrame) cardFrame = requestAnimationFrame(renderCards);
  };

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

  const primary = () => { if (saving || empty()) return; if (bridgeUp) download(); else save(); };
  saveBtn.addEventListener('click', primary);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') primary(); });
  input.addEventListener('input', () => { err.textContent = ''; reconnectBtn.hidden = true; linkMode(); });
  const paste = navigator.clipboard && navigator.clipboard.readText
    ? h('button', { class: 'btn-quiet', type: 'button', onclick: async () => { try { const t = await navigator.clipboard.readText(); const u = extractUrl(t); if (u) { input.value = u; err.textContent = ''; linkMode(); } else err.textContent = 'No link on the clipboard.'; } catch { /* refused */ } } }, 'Paste')
    : null;
  const phone = h('div', { class: 'form' },
    upBtn, picker,
    h('p', { class: 'link-note' }, `Already downloaded? Eagle adds it to ${libName ? `“${libName}”` : 'the library'} as soon as it opens — your computer downloads nothing.`));
  const form = h('div', { class: 'form' },
    h('div', { class: 'group-label flush' }, 'Or a link'),
    h('div', { class: 'field-row' }, input, paste), err, reconnectBtn,
    linkNote,
    saveBtn, pcBtn);
  S.shareOpen = true;
  // What finished before this sheet opened has been seen (its tile is in "All"); what's still going shows.
  W.list = W.list.filter((e) => !ENDED.has(e.state));
  uploadListeners.add(onUploads);
  W.listeners.add(onWatch);
  openSheet({
    title: 'Save to Eagle',
    sub: writable ? (libName ? `Into “${libName}”` : '') : 'Google will ask once to let Perch save to your Drive. Perch can only see the files it saves.',
    body: [phoneList, uploads, phone, done, form, recent],
    onClose: () => {
      S.shareOpen = false;
      closed = true;   // downloads carry on without the sheet (the watcher); only one not started yet is dropped
      for (const e of W.list) if (e.state === 'start' && !e.id && e.cancellable) e.cancelled = true;
      for (const u of blobUrls) URL.revokeObjectURL(u);
      uploadListeners.delete(onUploads);
      W.listeners.delete(onWatch);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(cardFrame);
      up().clearSaved();
      if (S.renewWhenIdle && !videoPlaying()) { S.renewWhenIdle = false; renewSoon('idle'); }
    },
  });
  up().refresh();
  renderCards();
  if (S.drive) loadRecent();
}

/** "42% · 1.2 MB of 2.9 MB" and the bar fraction (null: unknown) for a job in the phone downloader. */
function jobText(j) {
  if (j.status === 'queued') return ['Waiting…', null];
  if (j.status === 'processing') return ['Finishing…', 1];
  const p = j.progress != null ? j.progress : j.total ? j.downloaded / j.total : null;
  const size = j.total ? `${fmtBytes(j.downloaded)} of ${fmtBytes(j.total)}` : fmtBytes(j.downloaded);
  return [[p != null ? `${Math.floor(p * 100)}%` : '', size].filter(Boolean).join(' · ') || 'Downloading…', p];
}

// ── phone downloader ─────────────────────────────────────────────────────────
// yt-dlp in Termux on the phone (js/bridge.js). Android only; the row shows elsewhere once it's paired.
const ANDROID = /Android/i.test(navigator.userAgent);
const INSTALL_CMD = 'curl -fsSL https://fadil004.github.io/perch/bridge/install.sh | bash';
const TERMUX_URL = 'https://github.com/termux/termux-app/releases';

function cookieLine(c) {
  if (!c || !c.present) return 'No cookies — Instagram and X may need them';
  const from = c.source === 'file' ? 'from a file' : '';
  const when = Date.parse(c.updated || c.sourceTime || '');
  return `Cookies: ${[from, when ? timeAgo(when) : '', siteNames(c.sites || [])].filter(Boolean).join(' · ') || `${c.count || 0}`}`;
}

function openPhoneDownloader() {
  const cookieFile = h('input', { type: 'file', accept: '.txt,text/plain', hidden: true });
  const sheet = openSheet({
    title: 'Phone downloader',
    sub: 'Downloads shared links right on this phone.',
    body: h('div', { class: 'group-label' }, 'Checking…'),
  });
  let closed = false;
  sheet.closed.then(() => { closed = true; });

  const status = (state, text, ...lines) => h('div', { class: `dl-status ${state}` },
    h('span', { class: 'link-dot' }),
    h('div', { class: 'link-text' }, h('div', { class: 'link-title' }, text), ...lines.filter(Boolean).map((l) => h('div', { class: 'link-meta' }, l))));
  const row = (icon, label, onclick) => h('button', { class: 'row', type: 'button', onclick }, h('span', { class: 'ico', html: icon }), h('span', { class: 'label' }, label));
  const note = (text) => h('p', { class: 'link-note dl-note' }, text);
  const setupBtn = (label) => h('div', { class: 'form' }, h('button', { class: 'btn-primary', type: 'button', onclick: () => openBridgeSetup() }, label));

  function body(info, why) {
    if (info) {
      const c = info.cookies;
      return [
        status('on', 'Connected', `yt-dlp ${info.ytdlp || '?'}${info.busy ? ` · ${info.busy} downloading` : ''}`, cookieLine(c)),
        canUpload(info) ? null : note('Update the phone downloader: open Termux and type perch-update'),   // older ones can't send a shared link to Drive on their own
        c && c.present ? null : note('Export a cookies.txt on this phone (e.g. Firefox with the “cookies.txt” add-on, signed in to the site), then add it here.'),
        row(I.doc, 'Add cookies file', () => cookieFile.click()),
        c && c.present ? row(I.x, 'Remove cookies', removeCookies) : null,
        row(I.download, 'Setup steps', () => openBridgeSetup()),
        cookieFile,
      ];
    }
    if (why === 'unpaired') {
      return [status('', 'Not set up', 'Download Instagram, TikTok and YouTube links on this phone'), setupBtn('Set up')];
    }
    if (why === 'auth') {
      return [status('error', 'Not connected', 'The downloader on this phone has another key'), note('Run the setup command in Termux again.'), setupBtn('Set up again')];
    }
    return [
      status('error', 'Off — open Termux', 'Links are saved for your computer meanwhile'),
      note('Open Termux to start it. Still off with Termux open? Chrome may be blocking it: allow “Local network access” for this site in Chrome’s site settings.'),
      row(I.sync, 'Try again', () => { sheet.setBody(h('div', { class: 'group-label' }, 'Checking…')); refresh(); }),
      row(I.download, 'Setup steps', () => openBridgeSetup()),
    ];
  }
  async function refresh() {
    const info = await ping();
    if (!closed) sheet.setBody(body(info, pingProblem()));
  }
  async function removeCookies() {
    try { await clearCookies(); toast('Cookies removed'); } catch { toast('Couldn’t remove the cookies'); }
    refresh();
  }
  cookieFile.addEventListener('change', async () => {
    const f = cookieFile.files[0];
    cookieFile.value = '';
    if (!f) return;
    if (f.size > 5_000_000) { toast('That file is too big to be cookies'); return; }
    try {
      const r = await pushCookies(await f.text(), 'file', '');
      toast('Cookies added', r.sites && r.sites.length ? ` · ${siteNames(r.sites)}` : '');
    } catch (e) {
      toast(e.code === 'bad' ? 'No cookies found in that file' : 'Couldn’t add the cookies');
    }
    refresh();
  });
  refresh();
}

function openBridgeSetup() {
  const code = h('code', null, INSTALL_CMD);
  const copy = h('button', { class: 'cmd-copy', type: 'button', onclick: async () => {
    try { await navigator.clipboard.writeText(INSTALL_CMD); toast('Copied'); } catch {
      getSelection().selectAllChildren(code);   // no clipboard access: leave it selected for a long-press copy
      toast('Select the command and copy it');
    }
  } }, h('span', { class: 'ico', html: I.copy }), 'Copy');
  const step = (n, ...parts) => h('li', null, h('span', { class: 'step-n' }, String(n)), h('span', { class: 'step-t' }, ...parts));
  openSheet({
    title: 'Set up the phone downloader',
    sub: 'Once, on this phone. Takes a couple of minutes.',
    body: [
      h('ol', { class: 'steps' },
        step(1, 'Install ', h('b', null, 'Termux'), ' from F-Droid or ', h('a', { href: TERMUX_URL, target: '_blank', rel: 'noopener' }, 'GitHub'), '.'),
        step(2, 'Open Termux.'),
        step(3, 'Paste this command and press Enter:', h('div', { class: 'cmd' }, code, copy)),
        step(4, 'Settings → Apps → Termux → Battery → ', h('b', null, 'Unrestricted'), ', so Android doesn’t stop it.')),
      h('p', { class: 'link-note dl-note' }, 'When it finishes, Perch opens and says “Phone downloader connected”. Leave Termux running in the background.'),
    ],
  });
}

async function confirmSignOut() {
  // Videos sent from this phone that haven't reached Drive would be lost: say so before anything goes.
  const n = (await waiting().catch(() => [])).length;
  openSheet({
    title: 'Sign out?',
    sub: n
      ? `${n} ${n === 1 ? 'video hasn’t' : 'videos haven’t'} uploaded to Drive yet. Signing out removes ${n === 1 ? 'it' : 'them'} from this phone. Your library is forgotten on this device; nothing changes in Drive or Eagle.`
      : 'Perch forgets your library on this device. Nothing changes in Drive or Eagle.',
    body: h('div', { class: 'form' }, h('button', { class: 'btn-primary', type: 'button', style: { background: '#ff453a', color: '#fff' }, onclick: doSignOut }, 'Sign out')),
  });
}

async function doSignOut() {
  signOut();
  await clearWaiting();   // the user was told (and agreed) above
  lsSet('perch.mode', null);
  lsSet('perch.lib.drive', null);
  lsSet('perch.pasted.drive', null);
  lsSet('perch.pending.drive', null);
  lsSet('perch.inbox.cache.drive', null);
  await swkv.del('auth');
  await wipeAll();
  location.replace(location.pathname);
}

async function exitDemo() {
  lsSet('perch.mode', null);
  for (const k of ['perch.pending.', 'perch.inbox.', 'perch.inbox.cache.']) lsSet(k + S.modeKey, null);
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(`perch.deleted.${S.modeKey}.`)) localStorage.removeItem(k); } catch { /* ignore */ }
  try { await caches.delete(MOCK_CACHE); } catch { /* ignore */ }   // the demo inbox starts empty next time
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
/** A short message. `action` adds a button (e.g. Undo) that runs `onAction`; `ms` keeps it up longer. */
function toast(a, b, { action = '', onAction = null, ms = 1700 } = {}) {
  const parts = (b === undefined ? [a] : [a, b]).map((x) => (x instanceof Node ? x : document.createTextNode(String(x))));
  if (action && onAction) {
    parts.push(h('button', { class: 'toast-act', type: 'button', onclick: (e) => {
      e.stopPropagation();
      clearTimeout(toastTimer);
      el.toast.classList.remove('on');
      onAction();
    } }, action));
  }
  el.toast.replaceChildren(...parts);
  el.toast.classList.toggle('top', viewer.isOpen || isSheetOpen()); // stay clear of the sheet
  el.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('on'), ms);
}

addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  // Back from Google's page through the back/forward cache: the redirect we started never happened.
  if (S.redirecting) {
    S.redirecting = false;
    if (/Refreshing/.test(el.notice.textContent || '')) setNotice(null);
  }
  onResume();
});
addEventListener('online', () => {
  // Signed out by an expired token while offline: renew quietly now; a renew that works syncs (renewQuiet).
  if (S.mode === 'drive' && S.screen === 'main' && !S.redirecting && !tokenValid()) {
    renewQuiet('online').then((ok) => { if (!ok && !tokenValid() && S.authLost) onAuthLost(); });
  }
  if (S.screen === 'main' && canSend()) up().retrySoft({ now: true });
  flushDeletes();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) onResume();
  if (!document.hidden && S.screen === 'main' && !S.redirecting && canSend()) up().retrySoft();   // uploads left from last time
  if (!document.hidden && S.screen === 'main' && !S.redirecting) resumeWatcher();                 // downloads on the phone
  if (!document.hidden && S.screen === 'main' && !S.redirecting) refreshPending();
  if (document.hidden || S.redirecting || S.screen !== 'main' || !S.snap) return;
  if (Date.now() - S.snap.lastSync > 5 * 60_000 && (S.mode === 'demo' || tokenValid())) runSync({ background: true });
});
