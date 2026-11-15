// Quick share: a link shared to Perch from another app (Instagram, YouTube…) shouldn't leave the person
// inside Perch. Perch shows a one-line card, hands the link on — to the phone downloader (which downloads it
// and, with a version-2 bridge, uploads it to the Drive inbox itself) or, without one, straight into the Drive
// inbox for the computer — and closes itself so Android drops back to the app they came from.
//
// Google's sign-in lasts an hour, and most shares arrive later than that. So the download starts first, with
// no sign-in; then the sign-in is renewed (hidden frame, else one silent trip to Google and back, which lands
// in `resume` below) and handed to the downloader for the upload. Perch closes either way.
//
// When a step can't be done quietly (signed out, Google wants the user, no permission to write, an old
// downloader, any error) the answer says why and the normal Perch flow takes the link as before: it is still in
// the share queue, and a download already started is followed there instead of started again.
import { h, lsGet, lsSet } from './util.js';
import { I } from './icons.js';
import { getAuth, tokenLeft, canWrite, renewInFrame, frameRenewAllowed, canTrySilent, signIn, token, RENEW_AHEAD } from './auth.js';
import { createDrive, fetchBackend } from './drive.js';
import { withInbox, saveLink } from './inbox.js';
import { paired, ping, startDownload, attachUpload, rememberJob, canUpload } from './bridge.js';

const RENEW_CAP = 3000;     // the hidden-frame renew gets this long, no more: the card is on screen meanwhile
const INBOX_CAP = 4000;     // finding the inbox folder
const SAVE_CAP = 10000;     // saving a link for the computer
const QUICK_KEY = 'perch.quick';             // { url, job, off, t }: a quick share that went to Google and comes back
const QUICK_TTL = 60_000;
const NOFRAME_KEY = 'perch.quick.noframe';   // the hidden frame didn't deliver here: go straight to Google for a while
const NOFRAME_FOR = 3 * 24 * 3600_000;

/** A step that takes longer than `ms` counts as failed. */
function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

// ── the card ────────────────────────────────────────────────────────────────
const card = {
  el: () => document.getElementById('quick'),
  show(text) {
    const root = card.el();
    if (!root) return;
    root.classList.remove('done');
    root.querySelector('.quick-ico').replaceChildren(h('span', { class: 'quick-ring' }));
    root.querySelector('.quick-text').textContent = text;
    root.querySelector('.quick-sub').textContent = '';
    root.hidden = false;
  },
  done(text, sub = '') {
    const root = card.el();
    if (!root) return;
    root.classList.add('done');
    root.querySelector('.quick-ico').innerHTML = I.check;
    root.querySelector('.quick-text').textContent = text;
    root.querySelector('.quick-sub').textContent = sub;
  },
  hide() { const root = card.el(); if (root) root.hidden = true; },
};
export const hideQuickCard = () => card.hide();

/** The quick share that left for Google a moment ago (read once; an old one is forgotten). */
export function takeQuickMarker() {
  const m = lsGet(QUICK_KEY);
  if (m) lsSet(QUICK_KEY, null);
  return m && m.url && Date.now() - (m.t || 0) < QUICK_TTL ? m : null;
}

// ── what to send ────────────────────────────────────────────────────────────
const good = (a) => !!(a && a.token && canWrite(a) && tokenLeft(a) >= RENEW_AHEAD);

/** A sign-in good for a while yet: the one we have, or one renewed in the hidden frame. Null when neither. */
async function freshAuth() {
  const a = getAuth();
  if (good(a)) return a;
  if (!frameRenewAllowed() || Date.now() - (Number(lsGet(NOFRAME_KEY)) || 0) < NOFRAME_FOR) return null;
  const r = await renewInFrame({ timeout: RENEW_CAP });
  if (!r.ok) { lsSet(NOFRAME_KEY, Date.now()); return null; }   // slow or refused: next time go straight to Google
  return good(getAuth()) ? getAuth() : null;
}

const driveFor = () => createDrive({ backend: fetchBackend(), getToken: token, onAuthError: () => false });

/** What the bridge needs to upload for us (see "Upload" in bridge/API.md), or null when the inbox can't be found now. */
async function uploadInfo(a, libName) {
  try {
    const folder = await within(withInbox(driveFor(), 'drive', (id) => id), INBOX_CAP);
    return folder ? { token: a.token, expires: a.exp, folder, library: libName, from: 'Perch' } : null;
  } catch {
    return null;
  }
}

const done = (text, sub = '') => ({ ok: true, text, sub, toast: sub ? `${text} · ${sub}` : text });
const fall = (why) => ({ ok: false, why });

/**
 * Hand the link on. `back` is the marker of a share that went to Google for a sign-in and is now back.
 * Answers { ok, text, sub, toast } (handed over), { left } (on its way to Google) or { ok: false, why }.
 * `queueDrop(url)` only once the link is really in hand; `queuePut(url, { job })` ties a started download to it.
 */
async function handOver(url, { queuePut, queueDrop }, back) {
  const lib = lsGet('perch.lib.drive');
  const libName = (lib && lib.name) || '';
  if (!libName) return fall('library');   // no library opened yet
  const a0 = getAuth();
  if (!a0 || !a0.token) return fall('signedout');
  if (!canWrite(a0)) return fall('write');   // Google has to be asked first: the normal flow does that

  let job = (back && back.job) || '';
  let off = !!(back && back.off);
  let phone = !!job;
  if (!back && paired()) {
    const info = await ping({ timeout: 1500 });
    if (info && !canUpload(info)) return fall('old');   // the Phone downloader sheet says how to update it
    phone = !!info;
    off = !info;   // paired but not answering: the link goes to the computer instead
  }

  if (phone && !job) {
    // Start downloading now. With a sign-in that's still good the upload details go along; otherwise they follow.
    const upload = good(a0) ? await uploadInfo(a0, libName) : null;
    ({ id: job } = await startDownload(url, upload));
    rememberJob(job, url, libName);   // the normal watcher finds it on the next open (and reads the upload's outcome)
    if (upload) { queueDrop(url); return done('Downloading on your phone'); }
    queuePut(url, { job });   // if the sign-in fails now, the normal flow follows this download, not a second one
  }

  const a = await freshAuth();
  if (!a) {
    // One silent trip to Google and back. It leaves no history entry, so Perch can still close itself after.
    if (!back && canTrySilent()) {
      lsSet(QUICK_KEY, { url, job, off, t: Date.now() });
      signIn({ silent: true, replace: true });
      return { left: true };
    }
    return fall('signin');
  }

  if (phone) {
    const upload = await uploadInfo(a, libName);
    if (!upload) return fall('inbox');
    await attachUpload(job, upload);
    queueDrop(url);
    return done('Downloading on your phone');
  }
  await within(saveLink(driveFor(), 'drive', { url, library: lib }), SAVE_CAP);
  queueDrop(url);
  return done('Saved for your computer', off ? 'Phone downloader is off' : '');
}

/**
 * Show the card and hand the link over. Resolves with { ok: true, text, sub, toast } (the card says so and the
 * caller closes Perch), { left: true } (the page is leaving for Google; the card stays) or { ok: false, why }
 * (the card is gone, the normal flow continues).
 */
export async function quickShare(url, hooks, back = null) {
  card.show('Saving to Eagle…');
  let out;
  try {
    out = await handOver(url, hooks, back);
  } catch (e) {
    console.info('[perch] quick share fell back:', e && e.message);
    out = fall('error');
  }
  if (out.left) return out;
  if (!out.ok) { console.info('[perch] quick share fell back:', out.why); card.hide(); return out; }
  card.done(out.text, out.sub);
  return out;
}
