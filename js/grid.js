// Virtualized masonry. Heights come from Eagle's width/height, so the layout is final before any
// image loads. Only tiles within one screen of the viewport exist in the DOM.
import { h, clamp, fmtDuration, rgb, reducedMotion } from './util.js';
import { cachedThumb, loadThumb, thumbIdOf } from './thumbs.js';
import { I } from './icons.js';

const GAP = 4;

export class Grid {
  constructor(el, { onOpen, columns = 2 } = {}) {
    this.el = el;
    this.onOpen = onOpen;
    this.items = [];
    this.pref = columns;
    this.live = new Map();   // index -> tile element
    this.pool = [];
    this.ghost = -1;
    this.top = 0;
    this.width = 0;
    this.raf = 0;
    this.x = this.y = this.w = this.h = new Float32Array(0);

    addEventListener('scroll', () => this.schedule(), { passive: true });
    addEventListener('resize', () => this.schedule(true), { passive: true });
    new ResizeObserver(() => {
      const w = this.el.clientWidth;
      if (!w || w === this.width) return;
      if (!this.width || this.pending) {
        // First time we're visible: lay out from scratch, no anchoring.
        this.layout();
        this.render(true);
        if (this.pendingReveal) { this.pendingReveal = false; this.reveal(); }
      } else this.relayout();
    }).observe(el);

    el.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile || this.pinching) return;
      const i = Number(tile.dataset.i);
      this.onOpen && this.onOpen(i, tile);
    });
    // Press feedback lands on pointer-down, not on release.
    el.addEventListener('pointerdown', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile || e.button > 0) return;
      this.pressed = tile;
      this.pressTimer = setTimeout(() => tile.classList.add('pressed'), e.pointerType === 'touch' ? 40 : 0);
    });
    const unpress = () => {
      clearTimeout(this.pressTimer);
      if (this.pressed) this.pressed.classList.remove('pressed');
      this.pressed = null;
    };
    el.addEventListener('pointerup', unpress);
    el.addEventListener('pointercancel', unpress);
    el.addEventListener('pointerleave', unpress);
    addEventListener('scroll', unpress, { passive: true });
    this.bindPinch();
  }

  get columns() {
    const w = this.el.clientWidth || innerWidth;
    return w < 600 ? this.pref : w < 1000 ? this.pref + 1 : this.pref + 2;
  }

  setPreference(cols, anchorClientY) {
    if (cols === this.pref) return;
    const anchor = this.anchor(anchorClientY);
    this.pref = cols;
    this.layout();
    this.restoreAnchor(anchor);
    this.render(true);
    if (!reducedMotion.matches) {
      this.el.animate([{ opacity: 0.4, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.23,1,.32,1)' });
    }
  }

  setItems(items, { reveal = false, keepScroll = false } = {}) {
    this.items = items;
    for (const el of this.live.values()) this.release(el);
    this.live.clear();
    this.ghost = -1;
    if (!keepScroll) scrollTo(0, 0);
    this.layout();
    if (this.pending) { this.pendingReveal = reveal; return; }
    this.render(true);
    if (reveal) this.reveal();
  }

  layout() {
    const W = this.el.clientWidth;
    this.pending = !W;
    if (!W) { this.width = 0; return; }
    this.width = W;
    const cols = this.columns;
    const cw = (W - GAP * (cols - 1)) / cols;
    const heights = new Float64Array(cols);
    const n = this.items.length;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.w = new Float32Array(n);
    this.h = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const it = this.items[i];
      const ratio = it.w > 0 && it.h > 0 ? clamp(it.h / it.w, 0.28, 3.2) : 1;
      let col = 0;
      for (let c = 1; c < cols; c++) if (heights[c] < heights[col] - 0.5) col = c;
      const x0 = Math.round(col * (cw + GAP));
      const x1 = Math.round(col * (cw + GAP) + cw);
      const th = Math.max(24, Math.round(cw * ratio));
      this.x[i] = x0;
      this.w[i] = x1 - x0;
      this.y[i] = Math.round(heights[col]);
      this.h[i] = th;
      heights[col] += th + GAP;
    }
    this.total = n ? Math.max(...heights) - GAP : 0;
    this.el.style.height = `${Math.max(0, this.total)}px`;
    this.measureTop();
  }

  measureTop() {
    this.top = this.el.getBoundingClientRect().top + scrollY;
  }

  relayout() {
    const anchor = this.anchor();
    this.layout();
    this.restoreAnchor(anchor);
    this.render(true);
  }

  anchor(clientY = innerHeight * 0.33) {
    // The item nearest the given screen line keeps its place across a relayout.
    const line = scrollY + clientY - this.top;
    let best = -1, dist = Infinity;
    for (const [i] of this.live) {
      const d = Math.abs(this.y[i] + this.h[i] / 2 - line);
      if (d < dist) { dist = d; best = i; }
    }
    if (best < 0) return null;
    return { i: best, offset: this.top + this.y[best] - scrollY };
  }

  restoreAnchor(a) {
    if (!a || a.i >= this.items.length) return;
    this.measureTop();
    scrollTo(0, Math.max(0, this.top + this.y[a.i] - a.offset));
  }

  schedule(remeasure = false) {
    if (remeasure) this.needMeasure = true;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (this.needMeasure) { this.needMeasure = false; this.measureTop(); }
      this.render();
    });
  }

  render(force = false) {
    if (this.pending) return;
    const vh = innerHeight;
    const viewTop = scrollY - this.top;
    const from = viewTop - vh * 0.9;
    const to = viewTop + vh * 1.9;
    const n = this.items.length;
    const want = new Set();
    for (let i = 0; i < n; i++) {
      const y = this.y[i];
      if (y + this.h[i] >= from && y <= to) want.add(i);
    }
    for (const [i, el] of this.live) {
      if (!want.has(i)) { this.release(el); this.live.delete(i); }
    }
    for (const i of want) {
      if (!this.live.has(i)) {
        const el = this.acquire();
        this.fill(el, i);
        this.live.set(i, el);
      } else if (force) {
        this.place(this.live.get(i), i);
      }
    }
  }

  acquire() {
    const el = this.pool.pop();
    if (el) { el.hidden = false; return el; }
    const img = h('img', { alt: '', decoding: 'async', draggable: 'false' });
    const badge = h('span', { class: 'badge' });
    const tile = h('div', { class: 'tile', role: 'button', tabindex: '0' }, h('div', { class: 'tile-in' }, img, badge));
    tile._img = img;
    tile._badge = badge;
    this.el.append(tile);
    return tile;
  }

  release(el) {
    el._tok = (el._tok || 0) + 1;
    el.hidden = true;
    el.classList.remove('ghost', 'pressed');
    const img = el._img;
    img.classList.remove('in', 'instant');
    img.removeAttribute('src');
    this.pool.push(el);
  }

  place(el, i) {
    el.style.transform = `translate(${this.x[i]}px,${this.y[i]}px)`;
    el.style.width = `${this.w[i]}px`;
    el.style.height = `${this.h[i]}px`;
  }

  fill(el, i) {
    const it = this.items[i];
    this.place(el, i);
    el.dataset.i = i;
    el.style.backgroundColor = it.pal[0] ? rgb(it.pal[0]) : '#141416';
    el.classList.toggle('ghost', i === this.ghost);
    el.setAttribute('aria-label', it.name || it.ext);
    const badge = el._badge;
    badge.innerHTML = badgeHtml(it);
    const img = el._img;
    const tok = (el._tok = (el._tok || 0) + 1);
    const id = thumbIdOf(it);
    const hit = cachedThumb(id);
    if (hit) {
      img.classList.add('instant', 'in');
      img.src = hit;
      return;
    }
    if (!id) return;
    loadThumb(id).then((url) => {
      if (!url || el._tok !== tok) return;
      img.src = url;
      const show = () => { if (el._tok === tok) requestAnimationFrame(() => img.classList.add('in')); };
      if (img.decode) img.decode().then(show, show); else img.onload = show;
    });
  }

  reveal() {
    if (reducedMotion.matches) return;
    const visible = [...this.live.entries()]
      .filter(([i]) => this.top + this.y[i] < scrollY + innerHeight)
      .sort((a, b) => this.y[a[0]] - this.y[b[0]] || this.x[a[0]] - this.x[b[0]])
      .slice(0, 18);
    visible.forEach(([i, el], k) => {
      const t = `translate(${this.x[i]}px,${this.y[i]}px)`;
      el.animate(
        [{ opacity: 0, transform: `${t} translateY(14px) scale(.985)` }, { opacity: 1, transform: t }],
        { duration: 420, delay: 40 + k * 28, easing: 'cubic-bezier(.23,1,.32,1)', fill: 'backwards' },
      );
    });
  }

  /** Viewport rect of tile i (after making sure it's on screen), or null. */
  tileRect(i) {
    if (i < 0 || i >= this.items.length) return null;
    const top = this.top + this.y[i] - scrollY;
    const left = this.el.getBoundingClientRect().left + this.x[i];
    return { left, top, width: this.w[i], height: this.h[i] };
  }

  ensureVisible(i) {
    if (i < 0 || i >= this.items.length) return;
    const top = this.top + this.y[i] - scrollY;
    const bottom = top + this.h[i];
    const vh = innerHeight;
    if (top < 60 || bottom > vh - 90) {
      const target = this.top + this.y[i] - (vh - this.h[i]) / 2;
      scrollTo(0, clamp(target, 0, Math.max(0, document.documentElement.scrollHeight - vh)));
      this.render();
    }
  }

  setGhost(i) {
    if (this.ghost >= 0 && this.live.has(this.ghost)) this.live.get(this.ghost).classList.remove('ghost');
    this.ghost = i;
    if (i >= 0 && this.live.has(i)) this.live.get(i).classList.add('ghost');
  }

  thumbUrlAt(i) {
    const it = this.items[i];
    return it ? cachedThumb(thumbIdOf(it)) : null;
  }

  bindPinch() {
    const pts = new Map();
    let startDist = 0, startCols = 0, mid = 0, fired = false;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        startDist = dist(); startCols = this.pref; fired = false; this.pinching = true;
        const [a, b] = [...pts.values()]; mid = (a.y + b.y) / 2;
      }
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size !== 2 || fired || !startDist) return;
      const r = dist() / startDist;
      if (r > 1.18 && startCols > 2) { fired = true; this.onColumns && this.onColumns(startCols - 1, mid); }
      else if (r < 0.85 && startCols < 3) { fired = true; this.onColumns && this.onColumns(startCols + 1, mid); }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) { startDist = 0; setTimeout(() => { this.pinching = false; }, 60); }
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
    // iOS Safari: keep the page from zooming while pinching the grid.
    this.el.addEventListener('gesturestart', (e) => e.preventDefault());
  }
}

function badgeHtml(it) {
  if (it.kind === 'video') return it.duration ? fmtDuration(it.duration) : 'VIDEO';
  if (it.kind === 'gif') return 'GIF';
  if (it.kind === 'link') {
    const dur = it.duration ? `<span>${fmtDuration(it.duration)}</span>` : '';
    return (it.medium && it.videoID ? I.play : I.link) + dur;
  }
  if (it.kind === 'file') return it.ext ? it.ext.toUpperCase().slice(0, 5).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`) : '';
  return '';
}
