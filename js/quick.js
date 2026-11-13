// Quick share: a link shared to Perch from another app (Instagram, YouTube…) shouldn't leave the person
// inside Perch. Perch shows a one-line card for a second, hands the link on — to the phone downloader (which
// downloads it, and with a version-2 bridge also uploads it to the Drive inbox itself) or, without one, straight
// into the Drive inbox for the computer — and closes itself so Android drops back to the app they came from.
//
// Everything here only decides and sends. It never signs in or asks Google for anything: when a step can't be
// done quietly (signed out, no permission to write, the downloader is off or old, any error) it answers null
// and the normal Perch flow takes the link as before (the caller already queued it).
import { h, lsGet } from './util.js';
import { I } from './icons.js';
import { getAuth, tokenLeft, canWrite, renewInFrame, frameRenewAllowed, token, RENEW_AHEAD } from './auth.js';
import { createDrive, fetchBackend } from './drive.js';
import { withInbox, saveLink } from './inbox.js';
import { paired, ping, startDownload, rememberJob, canUpload } from './bridge.js';

const RENEW_CAP = 4000;     // a silent token renew gets this long, no more: the card is on screen meanwhile
const INBOX_CAP = 4000;     // finding the inbox folder
const SAVE_CAP = 10000;     // saving a link for the computer

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
    root.hidden = false;
  },
  done(text) {
    const root = card.el();
    if (!root) return;
    root.classList.add('done');
    root.querySelector('.quick-ico').innerHTML = I.check;
    root.querySelector('.quick-text').textContent = text;
  },
  hide() { const root = card.el(); if (root) root.hidden = true; },
};
export const hideQuickCard = () => card.hide();

// ── what to send ────────────────────────────────────────────────────────────
/** A token good for at least RENEW_AHEAD more (renewed quietly, briefly, if it isn't), or null. Needs the write scope. */
async function usableAuth() {
  let a = getAuth();
  if (!a || !a.token || !canWrite(a)) return null;
  if (tokenLeft(a) < RENEW_AHEAD) {
    if (!frameRenewAllowed()) return null;
    const r = await renewInFrame({ timeout: RENEW_CAP });
    if (!r.ok) return null;
    a = getAuth();
    if (!a || tokenLeft(a) < RENEW_AHEAD || !canWrite(a)) return null;
  }
  return a;
}

const driveFor = () => createDrive({ backend: fetchBackend(), getToken: token, onAuthError: () => false });

/** What the bridge needs to upload for us, or null (then no quick share: the normal flow takes the link). */
async function uploadInfo(libName) {
  try {
    const a = await usableAuth();
    if (!a) return null;
    const folder = await within(withInbox(driveFor(), 'drive', (id) => id), INBOX_CAP);
    return folder ? { token: a.token, expires: a.exp, folder, library: libName, from: 'Perch' } : null;
  } catch {
    return null;
  }
}

/**
 * Hand the link on. Resolves with { text, toast } once the bridge took it or the link is saved, or null when the
 * normal flow has to deal with it. `queueDrop(url)` removes the link from the share queue, which only happens
 * after it is really in hand: never before.
 */
async function handOver(url, { queueDrop }) {
  const lib = lsGet('perch.lib.drive');
  const libName = (lib && lib.name) || '';
  if (!libName) return null;   // no library opened yet: the normal flow
  if (!getAuth()?.token) return null;   // signed out: Google has to be asked, the normal flow does that
  if (paired()) {
    const info = await ping({ timeout: 1500 });
    if (!info || !canUpload(info)) return null;   // off, or an older downloader (the Phone downloader sheet says how to update it)
    // Only close when the downloader can take it all the way to Drive. Without a usable sign-in the video would sit in
    // the downloader, unseen, until Perch is opened again: the normal flow shows it instead (and asks Google if needed).
    const upload = await uploadInfo(libName);
    if (!upload) return null;
    const { id } = await startDownload(url, upload);
    rememberJob(id, url, libName);   // the normal watcher finds it on the next open (and reads the upload's outcome)
    queueDrop(url);
    return { text: 'Downloading on your phone', toast: 'Downloading on your phone' };
  }
  const a = await usableAuth();
  if (!a) return null;
  await within(saveLink(driveFor(), 'drive', { url, library: lib }), SAVE_CAP);
  queueDrop(url);
  return { text: 'Saved for your computer', toast: 'Saved for your computer' };
}

/**
 * Show the card and hand the link over. Resolves with { text, toast } (the card then says so and the caller closes
 * Perch) or null (the card is gone, the normal flow continues).
 */
export async function quickShare(url, hooks) {
  card.show('Saving to Eagle…');
  let out = null;
  try { out = await handOver(url, hooks); } catch (e) { console.info('[perch] quick share fell back:', e && e.message); }
  if (!out) { card.hide(); return null; }
  card.done(out.text);
  return out;
}
