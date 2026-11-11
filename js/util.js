// Small shared helpers: DOM, formatting, concurrency, springs, gesture math.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** A URL from library metadata, only if it is http(s); '' otherwise (no javascript:, data:, …). */
export function safeUrl(u) {
  if (typeof u !== 'string' || !u.trim()) return '';
  try {
    const url = new URL(u.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch { return ''; }
}
export const lerp = (a, b, t) => a + (b - a) * t;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60), r = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtBytes(n) {
  n = Number(n) || 0;
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function timeAgo(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d} d ago`;
  return fmtDate(ms);
}

export const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
export const hex = (c) => '#' + c.map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Limit concurrent async work. Returns run(fn) → Promise. */
export function pool(limit) {
  let active = 0;
  const q = [];
  const pump = () => {
    while (active < limit && q.length) {
      const { fn, res, rej } = q.shift();
      active++;
      Promise.resolve().then(fn).then(res, rej).finally(() => { active--; pump(); });
    }
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); });
}

/**
 * Spring toward `to`, starting at `from` with `velocity` (units/s).
 * Apple-style params: response (s) ≈ how quickly it gets there, damping 1 = no overshoot.
 */
export function spring({ from, to, velocity = 0, response = 0.35, damping = 1, precision = 0.05, onUpdate, onDone }) {
  const k = (2 * Math.PI / response) ** 2;
  const c = (4 * Math.PI * damping) / response;
  let x = from - to, v = velocity, last = 0, raf = 0, running = true;
  let resolve;
  const done = new Promise((r) => { resolve = r; });
  const finish = () => { running = false; onUpdate(to, 0); onDone && onDone(); resolve(true); };
  if (from === to && Math.abs(velocity) < precision) { queueMicrotask(finish); return { stop() {}, done, get value() { return to; } }; }
  const tick = (now) => {
    if (!running) return;
    let dt = last ? Math.min((now - last) / 1000, 1 / 24) : 1 / 60;
    last = now;
    while (dt > 1e-6) {
      const step = Math.min(dt, 1 / 240);
      v += (-k * x - c * v) * step;
      x += v * step;
      dt -= step;
    }
    if (Math.abs(x) < precision && Math.abs(v) < precision * 12) { finish(); return; }
    onUpdate(to + x, v);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return {
    stop() { if (!running) return; running = false; cancelAnimationFrame(raf); resolve(false); },
    done,
    get value() { return to + x; },
    get velocity() { return v; },
    get running() { return running; },
  };
}

/** Progressive resistance past a boundary. */
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Where a flick would come to rest (Apple's projection). velocity in px/s. */
export function project(velocity, decel = 0.998) {
  return ((velocity / 1000) * decel) / (1 - decel);
}

export class Velocity {
  constructor() { this.s = []; }
  reset() { this.s.length = 0; }
  add(x, y, t = performance.now()) {
    this.s.push({ x, y, t });
    while (this.s.length > 2 && t - this.s[0].t > 90) this.s.shift();
  }
  get() {
    const s = this.s;
    if (s.length < 2) return { vx: 0, vy: 0 };
    const a = s[0], b = s[s.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt };
  }
}

/** Read the live (presentation) translate/scale of an element. */
export function liveTransform(el) {
  const t = getComputedStyle(el).transform;
  if (!t || t === 'none') return { x: 0, y: 0, sx: 1, sy: 1 };
  const m = new DOMMatrixReadOnly(t);
  return { x: m.e, y: m.f, sx: m.a, sy: m.d };
}

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function lsGet(key, fallback = null) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function lsSet(key, value) {
  try { if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

let probe = null;
/** env(safe-area-inset-top) in px. */
export function safeTop() {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
    document.body.append(probe);
  }
  return probe.offsetHeight;
}
