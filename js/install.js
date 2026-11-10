// "Install as app": explains, per platform, how to put Perch on the home screen.
// Hidden whenever the app already runs installed (standalone).
import { h, lsGet, lsSet, reducedMotion } from './util.js';
import { openSheet, closeSheet } from './sheet.js';
import { I } from './icons.js';

const VARIANTS = ['ios', 'ios-inapp', 'android', 'android-noprompt'];
const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$|\.localhost$/.test(location.hostname);
const CARD_KEY = 'perch.installCard';

let deferred = null;   // BeforeInstallPromptEvent (Chrome on Android, desktop Chromium)
let installed = false;
let toast = () => {};
let card = null;
let cardScroll = 0;
const subscribers = new Set();
const changed = () => subscribers.forEach((fn) => fn());

addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; changed(); });
addEventListener('appinstalled', () => {
  installed = true;
  deferred = null;
  hideInstallCard();
  if (document.querySelector('.install-sheet')) closeSheet();
  changed();
});
addEventListener('scroll', () => { if (card && Math.abs(scrollY - cardScroll) > 260) hideInstallCard(); }, { passive: true });

export function initInstall(opts = {}) {
  if (opts.toast) toast = opts.toast;
}

export const onInstallChange = (fn) => subscribers.add(fn);

/** Dev-only: ?install=ios|ios-inapp|android|android-noprompt forces a variant (localhost / *.localhost). */
function override() {
  if (!DEV_HOST) return null;
  const v = new URLSearchParams(location.search).get('install');
  return VARIANTS.includes(v) ? v : null;
}

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/** The instructions that apply on this device, or null when there's nothing to offer. */
export function installVariant() {
  const forced = override();
  if (forced) return forced;
  if (installed || isStandalone()) return null;
  const ua = navigator.userAgent || '';
  const inApp = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|FB4A|Messenger|Snapchat|musical_ly|TikTok|BytedanceWebview|\bLine\/|MicroMessenger|Pinterest|LinkedInApp|GSA\//i.test(ua);
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  // iOS in-app browsers are WebViews: no "Safari/" token in the UA.
  if (iOS) return inApp || !/Safari\//.test(ua) ? 'ios-inapp' : 'ios';
  if (/Android/i.test(ua)) return deferred && !inApp && !/; wv\)/.test(ua) ? 'android' : 'android-noprompt';
  return deferred ? 'android' : null; // desktop Chromium that can install
}

export const canInstall = () => installVariant() !== null;

const appUrl = () => location.origin + location.pathname.replace(/index\.html$/, '');

async function copyLink() {
  const url = appUrl();
  let ok = false;
  try { await navigator.clipboard.writeText(url); ok = true; } catch { /* blocked in some in-app browsers */ }
  if (!ok) {
    const ta = h('textarea', { readonly: '', style: { position: 'fixed', top: '0', opacity: '0' } });
    ta.value = url;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  toast(ok ? 'Link copied' : url);
}

async function promptInstall() {
  if (!deferred) { // dev override, or the browser hasn't offered a prompt yet
    await closeSheet();
    openInstallSheet('android-noprompt');
    return;
  }
  const e = deferred;
  deferred = null;
  e.prompt();
  const choice = await e.userChoice.catch(() => null);
  await closeSheet();
  if (choice && choice.outcome === 'accepted') { installed = true; hideInstallCard(); }
  changed();
}

const glyph = (svg, cls = '') => h('span', { class: `glyph${cls ? ` ${cls}` : ''}`, html: svg });
const steps = (...rows) => h('ol', { class: 'steps' }, rows.map((parts, i) =>
  h('li', null, h('span', { class: 'step-n' }, String(i + 1)), h('span', { class: 'step-t' }, ...parts))));

export function openInstallSheet(variant = installVariant() || 'android-noprompt') {
  hideInstallCard();
  let body;
  if (variant === 'ios') {
    body = steps(
      ['Tap ', h('b', null, 'Share'), glyph(I.share, 'ios')],
      ['Tap ', h('b', null, 'Add to Home Screen'), glyph(I.plusSquare)],
    );
  } else if (variant === 'ios-inapp') {
    body = [
      h('p', { class: 'install-line' }, 'Open this page in Safari to install.'),
      h('div', { class: 'form' }, h('button', { class: 'btn-primary', type: 'button', onclick: copyLink }, 'Copy link')),
    ];
  } else if (variant === 'android') {
    body = h('div', { class: 'form' }, h('button', { class: 'btn-primary', type: 'button', onclick: promptInstall }, 'Install'));
  } else {
    body = [
      steps(
        ['Open this page in ', h('b', null, 'Chrome')],
        ['Tap ', glyph(I.menuV), ' then ', h('b', null, 'Install app'), h('small', null, 'or Add to Home screen')],
      ),
      h('div', { class: 'form' }, h('button', { class: 'btn-secondary', type: 'button', onclick: copyLink }, 'Copy link')),
    ];
  }
  return openSheet({
    title: 'Install Perch',
    sub: 'Put it on your home screen. It opens like an app.',
    body,
    className: `install-sheet install-${variant}`,
  });
}

/** One-time card after the first library load in the browser. */
export function maybeShowInstallCard() {
  if (card || lsGet(CARD_KEY) || !canInstall()) return;
  lsSet(CARD_KEY, Date.now());
  setTimeout(showCard, 1400);
}

function showCard() {
  if (card || !canInstall()) return;
  card = h('div', { class: 'install-card', role: 'dialog', 'aria-label': 'Install Perch' },
    h('span', { class: 'ic-icon', html: I.mark }),
    h('div', { class: 'ic-text' }, h('div', { class: 'ic-title' }, 'Install Perch'), h('div', { class: 'ic-sub' }, 'Use it like an app')),
    h('button', { class: 'ic-cta', type: 'button', onclick: () => openInstallSheet() }, 'Install'),
    h('button', { class: 'ic-x', type: 'button', 'aria-label': 'Dismiss', html: I.x, onclick: () => hideInstallCard() }));
  document.body.append(card);
  cardScroll = scrollY;
  if (!reducedMotion.matches) {
    card.animate([{ opacity: 0, transform: 'translateY(16px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.23,1,.32,1)' });
  }
}

export function hideInstallCard() {
  if (!card) return;
  const c = card;
  card = null;
  if (reducedMotion.matches) { c.remove(); return; }
  c.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(12px) scale(.98)' }], { duration: 180, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'forwards' })
    .finished.then(() => c.remove(), () => c.remove());
}
