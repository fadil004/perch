// Bottom sheet: springs in, follows the finger 1:1, dismisses by distance or flick.
import { h, spring, rubberband, project, Velocity, reducedMotion } from './util.js';
import { layers } from './layers.js';

let current = null;

export function closeSheet() {
  return current ? current.close() : Promise.resolve();
}

export function isSheetOpen() { return !!current; }

/**
 * openSheet({ title, sub, body, onClose }) → { el, body, close, setBody }
 * `body` is a Node (or array of Nodes) rendered in the scrollable area.
 */
export function openSheet({ title, sub, body, onClose, className = '' }) {
  if (current) current.close({ instant: true });
  const root = document.getElementById('sheets');
  const scrim = h('div', { class: 'sheet-scrim' });
  const grab = h('div', { class: 'sheet-grab' }, h('div', { class: 'sheet-handle' }));
  const head = title ? h('div', { class: 'sheet-head' }, h('div', { class: 'sheet-title', dir: 'auto' }, title), sub ? h('div', { class: 'sheet-sub' }, sub) : null) : null;
  const bodyEl = h('div', { class: 'sheet-body' });
  const sheet = h('div', { class: `sheet ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Sheet' }, grab, head, bodyEl);
  // (null entries are rows left out, as in h(); replaceChildren would print them as text)
  const setBody = (content) => { bodyEl.replaceChildren(...[].concat(content || []).filter((x) => x != null && x !== false)); refreshTouch(); };
  root.append(scrim, sheet);

  let y = 0, H = 0, anim = null, closing = false, closed = false;
  const apply = (v) => {
    y = v;
    sheet.style.transform = `translateY(${v}px)`;
    scrim.style.opacity = String(Math.max(0, Math.min(1, 1 - v / (H || 1))));
  };
  let touchQueued = false;
  const refreshTouch = () => {
    if (touchQueued) return;
    touchQueued = true;
    requestAnimationFrame(() => {
      touchQueued = false;
      // When nothing scrolls, the whole sheet is a drag surface.
      bodyEl.style.touchAction = bodyEl.scrollHeight <= bodyEl.clientHeight + 1 ? 'none' : 'pan-y';
    });
  };
  setBody(body);
  // Content that arrives later (progress rows, a video preview) can make the body scroll: check again.
  const grew = new MutationObserver(refreshTouch);
  grew.observe(bodyEl, { childList: true, subtree: true });
  bodyEl.addEventListener('loadedmetadata', refreshTouch, true);
  bodyEl.addEventListener('load', refreshTouch, true);

  H = sheet.getBoundingClientRect().height;
  apply(H);
  const toOpen = (velocity = 0) => {
    anim && anim.stop();
    if (reducedMotion.matches) { apply(0); return; }
    anim = spring({ from: y, to: 0, velocity, response: 0.42, damping: velocity ? 0.86 : 1, precision: 0.3, onUpdate: apply });
  };
  requestAnimationFrame(() => toOpen());

  let resolveClosed;
  const closedP = new Promise((r) => { resolveClosed = r; });
  const finish = () => {
    if (closed) return;
    closed = true;
    grew.disconnect();
    scrim.remove();
    sheet.remove();
    if (current === api) current = null;
    layers.remove(layerId);
    onClose && onClose();
    resolveClosed();
  };
  const close = ({ instant = false, velocity = 0 } = {}) => {
    if (closing) return closedP;
    closing = true;
    anim && anim.stop();
    if (instant || reducedMotion.matches) { finish(); return closedP; }
    H = sheet.getBoundingClientRect().height || H;
    anim = spring({ from: y, to: H + 8, velocity, response: 0.32, damping: 1, precision: 0.5, onUpdate: apply, onDone: finish });
    return closedP;
  };

  // Drag
  const vel = new Velocity();
  let drag = null;
  const down = (e) => {
    if (closing || e.button > 0) return;
    const fromBody = bodyEl.contains(e.target);
    if (fromBody && (bodyEl.style.touchAction !== 'none' || e.target.closest('input, textarea'))) return;
    anim && anim.stop();
    drag = { id: e.pointerId, y0: e.clientY, start: y, moved: false };
    vel.reset();
    vel.add(0, e.clientY);
  };
  const move = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 6) return;
    if (!drag.moved) { try { sheet.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
    drag.moved = true;
    vel.add(0, e.clientY);
    const target = drag.start + dy;
    apply(target < 0 ? -rubberband(-target, H) : target);
  };
  const up = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const moved = drag.moved;
    drag = null;
    if (!moved) return;
    const { vy } = vel.get();
    const rest = y + project(vy, 0.99);
    if (rest > H * 0.45 || vy > 900) close({ velocity: vy });
    else toOpen(vy);
  };
  sheet.addEventListener('pointerdown', down);
  sheet.addEventListener('pointermove', move);
  sheet.addEventListener('pointerup', up);
  sheet.addEventListener('pointercancel', up);
  // A tap on a row shouldn't count as a drag — swallow the click only if we actually dragged.
  scrim.addEventListener('click', () => close());

  const layerId = layers.push(() => close());
  const api = { el: sheet, body: bodyEl, close, setBody, closed: closedP };
  current = api;
  return api;
}
