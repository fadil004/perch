// Fullscreen viewer: shared-element open/close, 1:1 paging and dismiss with velocity handoff,
// pinch/double-tap zoom, inline video with a minimal scrubber, link embeds and an info sheet.
import { h, clamp, lerp, spring, rubberband, project, Velocity, liveTransform, fmtDuration, fmtBytes, fmtDate, rgb, hex, reducedMotion, lsGet, lsSet, safeTop } from './util.js';
import { I } from './icons.js';
import { cachedThumb, loadThumb, thumbIdOf } from './thumbs.js';
import { embedFor, hostOf } from './eagle.js';
import { layers } from './layers.js';

const GAP = 22;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
export const FOLDER_COLORS = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#32d74b', aqua: '#64d2ff', blue: '#0a84ff', purple: '#bf5af2', pink: '#ff375f' };

export class Viewer {
  constructor({ grid, media, getLibrary, onTag, onFolder, toast, canOpenDrive }) {
    this.grid = grid;
    this.mediaSrc = media;
    this.getLibrary = getLibrary;
    this.onTag = onTag;
    this.onFolder = onFolder;
    this.toast = toast;
    this.canOpenDrive = canOpenDrive;
    this.root = document.getElementById('viewer');
    this.bg = document.getElementById('v-bg');
    this.track = document.getElementById('v-track');
    this.chrome = document.getElementById('v-chrome');
    this.counter = document.getElementById('v-counter');
    this.bottom = document.getElementById('v-bottom');
    this.info = document.getElementById('v-info');
    this.items = [];
    this.index = 0;
    this.isOpen = false;
    this.slots = [];
    this.trackX = 0;
    this.zoom = { s: 1, x: 0, y: 0 };
    this.infoQ = 0;
    this.chromeOn = true;
    this.muted = lsGet('perch.muted', true);
    this.pointers = new Map();
    this.vel = new Velocity();

    const closeBtn = document.getElementById('v-close');
    const infoBtn = document.getElementById('v-info-btn');
    closeBtn.innerHTML = I.close;
    infoBtn.innerHTML = I.info;
    this.infoBtn = infoBtn;
    closeBtn.addEventListener('click', () => this.close());
    infoBtn.addEventListener('click', () => this.setInfo(this.infoQ < 0.5));

    for (let k = 0; k < 3; k++) this.slots.push(this.makeSlot());
    this.buildControls();
    this.bindGestures();
    this.bindInfoDrag();
    addEventListener('resize', () => { if (this.isOpen) this.relayout(); });
    addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); this.infoQ > 0.5 ? this.setInfo(false) : this.close(); }
      else if (e.key === 'ArrowRight') this.go(1);
      else if (e.key === 'ArrowLeft') this.go(-1);
      else if (e.key === 'i') this.setInfo(this.infoQ < 0.5);
      else if (e.key === ' ' && this.cur?.video) { e.preventDefault(); this.togglePlay(); }
    });
    this.root.addEventListener('wheel', (e) => e.preventDefault(), { passive: false });
  }

  get cur() { return this.slots[1]; }

  // ── layout ────────────────────────────────────────────────────────────────
  fit(it) {
    const vw = innerWidth, vh = innerHeight;
    let w = it?.w, hh = it?.h;
    if (!(w > 0 && hh > 0)) { w = 1; hh = 1; }
    const s = Math.min(vw / w, vh / hh);
    const fw = w * s, fh = hh * s;
    return { left: (vw - fw) / 2, top: (vh - fh) / 2, width: fw, height: fh };
  }

  makeSlot() {
    const thumb = h('img', { class: 'v-thumb', alt: '', draggable: 'false' });
    const zoom = h('div', { class: 'v-zoom' }, thumb);
    const media = h('div', { class: 'v-media' }, zoom);
    const load = h('div', { class: 'v-load' });
    const el = h('div', { class: 'v-slide' }, media, load);
    this.track.append(el);
    return { el, media, zoom, thumb, load, item: null, idx: -1, pos: 0, tok: 0, full: null, video: null, iframe: null, play: null, msg: null, blobUrl: null };
  }

  positionSlot(slot, pos) {
    slot.pos = pos;
    slot.el.style.transform = `translateX(${pos * (innerWidth + GAP)}px)`;
  }

  layoutSlot(slot) {
    if (!slot.item) return;
    const f = this.fit(slot.item);
    Object.assign(slot.media.style, { left: `${f.left}px`, top: `${f.top}px`, width: `${f.width}px`, height: `${f.height}px` });
    slot.fitRect = f;
  }

  relayout() {
    for (const s of this.slots) { this.positionSlot(s, s.pos); this.layoutSlot(s); }
    this.setZoom({ s: 1, x: 0, y: 0 });
    if (this.infoQ > 0) this.applyInfo(this.infoQ);
  }

  setSlot(slot, idx, pos) {
    this.clearSlot(slot);
    slot.idx = idx;
    slot.item = this.items[idx] || null;
    this.positionSlot(slot, pos);
    slot.el.hidden = !slot.item;
    if (!slot.item) return;
    this.layoutSlot(slot);
    slot.media.style.transform = '';
    slot.media.style.opacity = '';
    const it = slot.item;
    slot.media.style.backgroundColor = it.pal[0] ? rgb(it.pal[0]) : '#111';
    const id = thumbIdOf(it);
    const tok = slot.tok;
    const hit = cachedThumb(id);
    if (hit) slot.thumb.src = hit;
    else if (id) loadThumb(id).then((url) => { if (url && slot.tok === tok) slot.thumb.src = url; });
  }

  clearSlot(slot) {
    slot.tok++;
    if (slot.video) { try { slot.video.pause(); } catch { /* ignore */ } slot.video.removeAttribute('src'); slot.video.load(); slot.video.remove(); slot.video = null; }
    if (slot.iframe) { slot.iframe.remove(); slot.iframe = null; }
    if (slot.full) { slot.full.remove(); slot.full = null; }
    if (slot.play) { slot.play.remove(); slot.play = null; }
    if (slot.msg) { slot.msg.remove(); slot.msg = null; }
    if (slot.blobUrl) { URL.revokeObjectURL(slot.blobUrl); slot.blobUrl = null; }
    slot.load.classList.remove('on');
    slot.thumb.removeAttribute('src');
    slot.media.style.backgroundColor = '';
    slot.media.classList.remove('clip');
    slot.zoom.style.transform = '';
  }

  // ── media per kind ────────────────────────────────────────────────────────
  async activate(slot) {
    const it = slot.item;
    if (!it) return;
    const tok = slot.tok;
    if (it.kind === 'image' || it.kind === 'gif') {
      if (!slot.full && it.f.main) this.loadFull(slot);
    } else if (it.kind === 'video' && it.f.main) {
      const v = h('video', { playsinline: '', 'webkit-playsinline': '', loop: '', preload: 'auto', disablepictureinpicture: '' });
      v.muted = this.muted;
      v.playsInline = true;
      if (slot.thumb.src) v.poster = slot.thumb.src;
      slot.zoom.append(v);
      slot.video = v;
      this.attachVideo(v, slot);
      slot.load.classList.add('on');
      try {
        const src = await this.mediaSrc.src(it.f.main, { size: it.size, onProgress: (p) => this.progress(slot, p) });
        if (slot.tok !== tok) { if (src.startsWith('blob:')) URL.revokeObjectURL(src); return; }
        if (src.startsWith('blob:')) slot.blobUrl = src;
        v.src = src;
        const p = v.play();
        if (p && p.catch) p.catch(() => { this.vcSync(); });
      } catch (e) {
        if (slot.tok === tok) this.fail(slot, e);
      }
    } else if (it.kind === 'link') {
      const emb = embedFor(it);
      if (emb && !slot.iframe) {
        const play = h('button', { class: 'v-play', type: 'button', 'aria-label': 'Play', html: I.play });
        play.addEventListener('click', (e) => {
          e.stopPropagation();
          const frame = h('iframe', { class: 'v-embed', src: emb.src, allow: 'autoplay; fullscreen; picture-in-picture; encrypted-media', allowfullscreen: '', referrerpolicy: 'strict-origin-when-cross-origin', title: it.name });
          // Keep the thumbnail on screen until the player has actually loaded.
          frame.style.opacity = '0';
          slot.load.classList.add('on');
          frame.addEventListener('load', () => {
            slot.load.classList.remove('on');
            frame.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
            frame.style.opacity = '1';
          }, { once: true });
          slot.zoom.append(frame);
          slot.iframe = frame;
          play.remove();
          slot.play = null;
        });
        slot.media.append(play);
        slot.play = play;
      }
    }
  }

  async loadFull(slot) {
    const it = slot.item, tok = slot.tok;
    try {
      const src = await this.mediaSrc.src(it.f.main, { size: it.size });
      if (slot.tok !== tok) { if (src.startsWith('blob:')) URL.revokeObjectURL(src); return; }
      if (src.startsWith('blob:')) slot.blobUrl = src;
      const img = h('img', { class: 'v-full', alt: '', draggable: 'false' });
      img.onload = () => { if (slot.tok === tok) requestAnimationFrame(() => img.classList.add('in')); };
      img.onerror = () => img.remove();
      img.src = src;
      slot.zoom.append(img);
      slot.full = img;
    } catch { /* thumbnail stays */ }
  }

  progress(slot, p) {
    if (slot !== this.cur) return;
    slot.load.classList.toggle('on', p < 1);
  }

  fail(slot, e) {
    slot.load.classList.remove('on');
    if (slot.msg) slot.msg.remove();
    const auth = e && e.name === 'AuthError';
    slot.msg = h('div', { class: 'v-msg' }, auth ? 'Reconnect to play' : navigator.onLine ? 'Couldn’t load this file' : 'You’re offline');
    slot.el.append(slot.msg);
  }

  // ── open / close ──────────────────────────────────────────────────────────
  open(items, index, originRect) {
    if (this.isOpen) return;
    this.items = items;
    this.index = index;
    this.isOpen = true;
    this.closing = false;
    this.root.hidden = false;
    this.trackX = 0;
    this.setTrack(0);
    this.infoQ = 0;
    this.applyInfo(0);
    this.zoom = { s: 1, x: 0, y: 0 };
    this.setSlot(this.slots[0], index - 1, -1);
    this.setSlot(this.slots[1], index, 0);
    this.setSlot(this.slots[2], index + 1, 1);
    this.updateChromeFor();
    this.setChrome(true, true);
    this.grid.setGhost(index);
    this.layerId = layers.push(() => this.close({ fromHistory: true }));

    const cur = this.cur, f = cur.fitRect;
    const thumbUrl = this.grid.thumbUrlAt(index);
    if (thumbUrl && !cur.thumb.src) cur.thumb.src = thumbUrl;
    const neighbours = [this.slots[0].el, this.slots[2].el];

    if (originRect && f && !reducedMotion.matches) {
      const sx = originRect.width / f.width, sy = originRect.height / f.height;
      const from = `translate(${originRect.left - f.left}px, ${originRect.top - f.top}px) scale(${sx}, ${sy})`;
      cur.media.classList.add('clip');
      neighbours.forEach((n) => { n.style.opacity = '0'; });
      this.openAnim = cur.media.animate(
        [{ transform: from, borderRadius: `${4 / sx}px / ${4 / sy}px` }, { transform: 'none', borderRadius: '0px' }],
        { duration: 360, easing: EASE },
      );
      this.bg.style.opacity = '1';
      this.bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 280, easing: 'cubic-bezier(.23,1,.32,1)' });
      this.chrome.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 140, easing: 'ease-out', fill: 'backwards' });
      this.openAnim.finished.catch(() => {}).then(() => {
        this.openAnim = null;
        cur.media.classList.remove('clip');
        neighbours.forEach((n) => { n.style.opacity = ''; });
        if (this.isOpen && !this.closing) this.activate(this.cur);
      });
    } else {
      this.bg.style.opacity = '1';
      this.root.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      this.activate(cur);
    }
    this.preloadNeighbours();
  }

  /** Close back into the grid tile (or fade if the tile isn't available). */
  close({ velocity = 0, fromHistory = false } = {}) {
    if (!this.isOpen || this.closing) return;
    this.closing = true;
    if (this.openAnim) { this.openAnim.finish(); }
    this.pageAnim && this.pageAnim.stop();
    clearTimeout(this.chromeTimer);
    const cur = this.cur;
    if (cur.video) { try { cur.video.pause(); } catch { /* ignore */ } }
    if (cur.iframe) { cur.iframe.remove(); cur.iframe = null; }
    if (this.infoQ > 0) this.applyInfo(0, true);
    this.setChrome(false);
    if (!fromHistory) layers.remove(this.layerId);

    const f = cur.fitRect;
    this.grid.ensureVisible(this.index);
    this.grid.setGhost(this.index);
    const rect = this.grid.tileRect(this.index);
    const live = liveTransform(cur.media);
    const z = { ...this.zoom };
    const bg0 = Number(getComputedStyle(this.bg).opacity) || 0;
    const target = rect && f
      ? { x: rect.left - f.left, y: rect.top - f.top, sx: rect.width / f.width, sy: rect.height / f.height }
      : { x: live.x + (f ? f.width * 0.05 : 0), y: live.y + 30, sx: live.sx * 0.9, sy: live.sy * 0.9 };
    cur.media.classList.add('clip');
    const done = () => {
      this.root.hidden = true;
      this.isOpen = false;
      this.closing = false;
      this.grid.setGhost(-1);
      for (const s of this.slots) this.clearSlot(s);
      this.bg.style.opacity = '0';
    };
    if (reducedMotion.matches) {
      this.root.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'ease-out' }).finished.then(done, done);
      return;
    }
    const dist = target.y - live.y;
    const rel = dist && velocity ? clamp(velocity / dist, -10, 10) : 0;
    spring({
      from: 0, to: 1, velocity: rel, response: 0.38, damping: 1, precision: 0.0015,
      onUpdate: (p) => {
        const x = lerp(live.x, target.x, p), y = lerp(live.y, target.y, p);
        const sx = lerp(live.sx, target.sx, p), sy = lerp(live.sy, target.sy, p);
        cur.media.style.transform = `translate(${x}px, ${y}px) scale(${sx}, ${sy})`;
        const r = lerp(0, 4, p);
        cur.media.style.borderRadius = `${r / sx}px / ${r / sy}px`;
        if (z.s !== 1) cur.zoom.style.transform = `translate(${lerp(z.x, 0, p)}px, ${lerp(z.y, 0, p)}px) scale(${lerp(z.s, 1, p)})`;
        this.bg.style.opacity = String(lerp(bg0, 0, Math.min(1, p * 1.25)));
        if (!rect) cur.media.style.opacity = String(1 - p);
      },
      onDone: () => { cur.media.style.borderRadius = ''; done(); },
    });
  }

  // ── paging ────────────────────────────────────────────────────────────────
  setTrack(x) {
    this.trackX = x;
    this.track.style.transform = `translateX(${x}px)`;
  }

  go(dir, velocity = 0) {
    if (!this.isOpen || this.closing) return;
    const next = this.index + dir;
    if (dir && (next < 0 || next >= this.items.length)) dir = 0;
    if (this.pageAnim) this.pageAnim.stop();
    const W = innerWidth + GAP;
    const target = -dir * W;
    if (reducedMotion.matches) { this.setTrack(target); if (dir) this.shift(dir); else this.setTrack(0); return; }
    this.pageAnim = spring({
      from: this.trackX, to: target, velocity, response: 0.36, damping: 1, precision: 0.4,
      onUpdate: (v) => this.setTrack(v),
      onDone: () => { this.pageAnim = null; if (dir) this.shift(dir); },
    });
  }

  shift(dir) {
    const old = this.cur;
    this.index += dir;
    if (dir > 0) {
      const s = this.slots.shift();
      this.slots.push(s);
      this.setSlot(s, this.index + 1, 1);
    } else {
      const s = this.slots.pop();
      this.slots.unshift(s);
      this.setSlot(s, this.index - 1, -1);
    }
    this.positionSlot(this.slots[0], -1);
    this.positionSlot(this.slots[1], 0);
    this.positionSlot(this.slots[2], 1);
    this.setTrack(this.trackX + dir * (innerWidth + GAP));
    if (Math.abs(this.trackX) < 0.5) this.setTrack(0);
    // Old current becomes a neighbour: stop its media but keep the thumbnail.
    if (old.video) { old.video.pause(); old.video.removeAttribute('src'); old.video.load(); old.video.remove(); old.video = null; }
    if (old.iframe) { old.iframe.remove(); old.iframe = null; }
    if (old.play) { old.play.remove(); old.play = null; }
    old.zoom.style.transform = '';
    this.zoom = { s: 1, x: 0, y: 0 };
    this.activate(this.cur);
    this.updateChromeFor();
    this.grid.ensureVisible(this.index);
    this.grid.setGhost(this.index);
    this.preloadNeighbours();
  }

  preloadNeighbours() {
    for (const s of [this.slots[0], this.slots[2]]) {
      const it = s.item;
      if (it && (it.kind === 'image') && !s.full) this.loadFull(s);
    }
    for (const k of [this.index + 2, this.index - 2]) {
      const it = this.items[k];
      if (it) loadThumb(thumbIdOf(it));
    }
  }

  // ── chrome ────────────────────────────────────────────────────────────────
  setChrome(on, instant = false) {
    this.chromeOn = on;
    this.chrome.classList.toggle('off', !on);
    if (instant) { this.chrome.style.transition = 'none'; requestAnimationFrame(() => { this.chrome.style.transition = ''; }); }
    if (on) this.scheduleChromeHide();
  }

  scheduleChromeHide() {
    clearTimeout(this.chromeTimer);
    const v = this.cur?.video;
    if (v && !v.paused && this.infoQ === 0) {
      this.chromeTimer = setTimeout(() => { if (this.cur?.video && !this.cur.video.paused && !this.scrubbing && this.infoQ === 0) this.setChrome(false); }, 2800);
    }
  }

  updateChromeFor() {
    const it = this.cur.item;
    this.counter.textContent = this.items.length > 1 ? `${this.index + 1} / ${this.items.length}` : '';
    this.bottom.replaceChildren();
    if (!it) return;
    if (it.kind === 'video') {
      this.bottom.append(this.vc.root);
      this.vcReset(it);
    } else if (it.kind === 'link' && it.url) {
      this.bottom.append(h('a', { class: 'v-open', href: it.url, target: '_blank', rel: 'noopener noreferrer' }, h('span', { html: I.external, style: { display: 'contents' } }), h('span', null, hostOf(it.url) || 'Open link')));
    } else if (it.kind === 'file' && it.f.main && this.canOpenDrive()) {
      this.bottom.append(h('a', { class: 'v-open', href: `https://drive.google.com/file/d/${encodeURIComponent(it.f.main)}/view`, target: '_blank', rel: 'noopener noreferrer' }, h('span', { html: I.drive, style: { display: 'contents' } }), h('span', null, 'Open in Drive')));
    }
    if (this.infoQ > 0) { this.renderInfo(); this.infoH = this.infoHeight(); this.applyInfo(this.infoQ); }
  }

  // ── video controls ────────────────────────────────────────────────────────
  buildControls() {
    const play = h('button', { type: 'button', 'aria-label': 'Play' });
    const t = h('span', { class: 'vc-t' }, '0:00');
    const buf = h('i', { class: 'vc-buf' });
    const fill = h('i', { class: 'vc-fill' });
    const knob = h('i', { class: 'vc-knob' });
    const rail = h('div', { class: 'vc-rail' }, buf, fill, knob);
    const scrub = h('div', { class: 'vc-scrub', role: 'slider', 'aria-label': 'Seek' }, rail);
    const d = h('span', { class: 'vc-t' }, '0:00');
    const mute = h('button', { type: 'button', 'aria-label': 'Sound' });
    const root = h('div', { class: 'vc' }, play, t, scrub, d, mute);
    this.vc = { root, play, t, buf, fill, knob, rail, scrub, d, mute };
    play.addEventListener('click', (e) => { e.stopPropagation(); this.togglePlay(); });
    mute.addEventListener('click', (e) => {
      e.stopPropagation();
      this.muted = !this.muted;
      lsSet('perch.muted', this.muted);
      if (this.cur.video) this.cur.video.muted = this.muted;
      this.vcSync();
      this.scheduleChromeHide();
    });
    const seekTo = (clientX) => {
      const v = this.cur.video;
      if (!v || !isFinite(v.duration) || !v.duration) return;
      const r = rail.getBoundingClientRect();
      const p = clamp((clientX - r.left) / r.width, 0, 1);
      v.currentTime = p * v.duration;
      this.vcPaint(p);
    };
    scrub.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      scrub.setPointerCapture(e.pointerId);
      this.scrubbing = true;
      scrub.classList.add('active');
      const v = this.cur.video;
      this.wasPlaying = v && !v.paused;
      if (v) v.pause();
      seekTo(e.clientX);
    });
    scrub.addEventListener('pointermove', (e) => { if (this.scrubbing) seekTo(e.clientX); });
    const end = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      scrub.classList.remove('active');
      const v = this.cur.video;
      if (v && this.wasPlaying) v.play().catch(() => {});
      this.scheduleChromeHide();
    };
    scrub.addEventListener('pointerup', end);
    scrub.addEventListener('pointercancel', end);
  }

  vcReset(it) {
    this.vc.t.textContent = '0:00';
    this.vc.d.textContent = it.duration ? fmtDuration(it.duration) : '0:00';
    this.vcPaint(0);
    this.vc.buf.style.transform = 'scaleX(0)';
    this.vcSync();
  }

  vcPaint(p) {
    this.vc.fill.style.transform = `scaleX(${p})`;
    this.vc.knob.style.left = `${p * 100}%`;
  }

  vcSync() {
    const v = this.cur?.video;
    const playing = v && !v.paused;
    this.vc.play.innerHTML = playing ? I.pause : I.play;
    this.vc.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.vc.mute.innerHTML = this.muted ? I.muted : I.sound;
    this.vc.mute.setAttribute('aria-label', this.muted ? 'Unmute' : 'Mute');
  }

  attachVideo(v, slot) {
    const isCur = () => slot === this.cur && slot.video === v;
    const tick = () => {
      if (!isCur()) return;
      if (v.duration && isFinite(v.duration)) {
        if (!this.scrubbing) this.vcPaint(v.currentTime / v.duration);
        this.vc.t.textContent = fmtDuration(v.currentTime);
      }
      if (!v.paused) v._raf = requestAnimationFrame(tick);
    };
    v.addEventListener('loadedmetadata', () => { if (isCur() && isFinite(v.duration)) this.vc.d.textContent = fmtDuration(v.duration); });
    v.addEventListener('play', () => { if (!isCur()) return; this.vcSync(); cancelAnimationFrame(v._raf); v._raf = requestAnimationFrame(tick); this.scheduleChromeHide(); });
    v.addEventListener('pause', () => { if (!isCur()) return; this.vcSync(); clearTimeout(this.chromeTimer); });
    v.addEventListener('waiting', () => { if (isCur()) slot.load.classList.add('on'); });
    v.addEventListener('canplay', () => slot.load.classList.remove('on'));
    v.addEventListener('playing', () => slot.load.classList.remove('on'));
    v.addEventListener('progress', () => {
      if (!isCur() || !v.duration || !isFinite(v.duration) || !v.buffered.length) return;
      this.vc.buf.style.transform = `scaleX(${clamp(v.buffered.end(v.buffered.length - 1) / v.duration, 0, 1)})`;
    });
    v.addEventListener('timeupdate', () => { if (isCur() && v.paused) tick(); });
    v.addEventListener('error', () => {
      if (slot.video !== v || !v.getAttribute('src')) return;
      this.fail(slot, this.mediaSrc.lastError ? this.mediaSrc.lastError() : null);
    });
  }

  togglePlay() {
    const v = this.cur.video;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
    this.pulse(v.paused ? I.play : I.pause);
  }

  pulse(icon) {
    if (reducedMotion.matches) return;
    const p = h('div', { class: 'v-pulse', html: icon });
    this.cur.el.append(p);
    p.animate([{ opacity: 0, transform: 'scale(.85)' }, { opacity: 1, transform: 'scale(1)', offset: 0.3 }, { opacity: 0, transform: 'scale(1.08)' }], { duration: 520, easing: 'cubic-bezier(.23,1,.32,1)' }).finished.then(() => p.remove(), () => p.remove());
  }

  // ── zoom ──────────────────────────────────────────────────────────────────
  zoomable() {
    const it = this.cur.item;
    return it && (it.kind === 'image' || it.kind === 'gif' || it.kind === 'file' || (it.kind === 'link' && !this.cur.iframe));
  }

  setZoom(z) {
    this.zoom = z;
    this.cur.zoom.style.transform = z.s === 1 && !z.x && !z.y ? '' : `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  }

  zoomBounds(s) {
    const f = this.cur.fitRect, vw = innerWidth, vh = innerHeight;
    const w = f.width * s, hh = f.height * s;
    const bx = w <= vw ? [(vw - w) / 2 - f.left, (vw - w) / 2 - f.left] : [vw - f.left - w, -f.left];
    const by = hh <= vh ? [(vh - hh) / 2 - f.top, (vh - hh) / 2 - f.top] : [vh - f.top - hh, -f.top];
    return { bx, by };
  }

  animateZoom(to, velocity = { x: 0, y: 0 }) {
    this.zoomAnim && this.zoomAnim.stop();
    const from = { ...this.zoom };
    if (reducedMotion.matches) { this.setZoom(to); return; }
    this.zoomAnim = spring({
      from: 0, to: 1, response: 0.34, damping: 1, precision: 0.002,
      velocity: Math.abs(to.x - from.x) > 1 ? clamp(velocity.x / (to.x - from.x), -8, 8) : 0,
      onUpdate: (p) => this.setZoom({ s: lerp(from.s, to.s, p), x: lerp(from.x, to.x, p), y: lerp(from.y, to.y, p) }),
    });
  }

  toggleZoomAt(cx, cy) {
    if (this.zoom.s > 1.01) { this.animateZoom({ s: 1, x: 0, y: 0 }); return; }
    const f = this.cur.fitRect;
    const s = Math.max(2.5, Math.min(4, innerWidth / f.width, innerHeight / f.height) * 1.0);
    const lx = cx - f.left, ly = cy - f.top;
    const { bx, by } = this.zoomBounds(s);
    this.animateZoom({ s, x: clamp(lx * (1 - s), bx[0], bx[1]), y: clamp(ly * (1 - s), by[0], by[1]) });
  }

  settleZoom(velocity) {
    let { s, x, y } = this.zoom;
    if (s <= 1.02) { this.animateZoom({ s: 1, x: 0, y: 0 }); return; }
    s = clamp(s, 1, 5);
    const { bx, by } = this.zoomBounds(s);
    const px = velocity ? x + project(velocity.vx, 0.995) : x;
    const py = velocity ? y + project(velocity.vy, 0.995) : y;
    this.animateZoom({ s, x: clamp(px, bx[0], bx[1]), y: clamp(py, by[0], by[1]) }, { x: velocity ? velocity.vx : 0 });
  }

  // ── info sheet ────────────────────────────────────────────────────────────
  renderInfo() {
    const it = this.cur.item;
    const lib = this.getLibrary();
    if (!it) return;
    const meta = [it.ext ? it.ext.toUpperCase() : '', it.w && it.h ? `${it.w} × ${it.h}` : '', fmtBytes(it.size), it.duration ? fmtDuration(it.duration) : ''].filter(Boolean).join('  ·  ');
    const kids = [h('div', { class: 'sheet-grab', id: 'v-info-grab' }, h('div', { class: 'sheet-handle' }))];
    kids.push(h('div', { class: 'i-title', dir: 'auto' }, it.name || 'Untitled'));
    if (meta) kids.push(h('div', { class: 'i-meta' }, meta));
    if (it.star) {
      kids.push(h('div', { class: 'i-stars', 'aria-label': `${it.star} of 5` }, [1, 2, 3, 4, 5].map((k) => {
        const span = h('span', { html: I.star });
        span.firstChild.classList.add(k <= it.star ? 'on' : 'off');
        return span;
      })));
    }
    if (it.pal.length) {
      kids.push(h('div', { class: 'i-sec' }, h('div', { class: 'i-label' }, 'Palette'), h('div', { class: 'i-swatches' }, it.pal.map((c) => h('button', {
        class: 'i-sw', type: 'button', style: { background: rgb(c) }, 'aria-label': hex(c),
        onclick: () => this.copyHex(c),
      })))));
    }
    if (it.tags.length) {
      kids.push(h('div', { class: 'i-sec' }, h('div', { class: 'i-label' }, 'Tags'), h('div', { class: 'i-chips' }, it.tags.map((t) => h('button', {
        class: 'chip', type: 'button', dir: 'auto', onclick: () => this.onTag(t),
      }, t)))));
    }
    const folders = it.folders.map((fid) => lib?.folders.get(fid)).filter(Boolean);
    if (folders.length) {
      kids.push(h('div', { class: 'i-sec' }, h('div', { class: 'i-label' }, 'Folders'), h('div', { class: 'i-chips' }, folders.map((f) => h('button', {
        class: 'chip i-folder', type: 'button', onclick: () => this.onFolder(f.id),
      }, h('span', { class: 'dot', style: { background: FOLDER_COLORS[f.color] || '#5b5b60' } }), h('span', { dir: 'auto' }, f.name))))));
    }
    if (it.url) {
      kids.push(h('div', { class: 'i-sec' }, h('div', { class: 'i-label' }, 'Source'), h('a', { class: 'i-link', href: it.url, target: '_blank', rel: 'noopener noreferrer' }, h('span', { dir: 'auto' }, it.url.replace(/^https?:\/\/(www\.)?/, '')), h('i', { html: I.external, style: { display: 'contents' } }))));
    }
    if (it.note) kids.push(h('div', { class: 'i-sec' }, h('div', { class: 'i-label' }, 'Notes'), h('div', { class: 'i-note', dir: 'auto' }, it.note)));
    if (it.btime) kids.push(h('div', { class: 'i-sec' }, h('div', { class: 'i-label' }, 'Added'), h('div', { class: 'i-date' }, fmtDate(it.btime))));
    this.info.replaceChildren(...kids);
    this.info.scrollTop = 0;
  }

  async copyHex(c) {
    const value = hex(c);
    try { await navigator.clipboard.writeText(value); } catch { /* clipboard blocked */ }
    this.toast(h('span', null, h('i', { class: 'sw', style: { background: rgb(c) } })), `Copied ${value}`);
  }

  infoHeight() {
    return this.info.getBoundingClientRect().height || innerHeight * 0.5;
  }

  /** q: 0 = closed, 1 = open. Moves the sheet and lifts the media into the space above it. */
  applyInfo(q, instant = false) {
    this.infoQ = q;
    const Hs = this.infoH || this.infoHeight();
    this.info.style.transform = `translateY(${lerp(Hs + 24, 0, clamp(q, 0, 1.2))}px)`;
    this.infoBtn.classList.toggle('on', q > 0.5);
    const cur = this.cur, f = cur.fitRect;
    if (!f) return;
    const sat = safeTop();
    const avail = Math.max(80, innerHeight - Hs - sat - 64);
    const s = Math.min(1, avail / f.height, (innerWidth - 32) / f.width);
    const top = sat + 52 + (avail - f.height * s) / 2;
    const left = (innerWidth - f.width * s) / 2;
    const p = clamp(q, 0, 1);
    const tx = lerp(0, left - f.left, p), ty = lerp(0, top - f.top, p), sc = lerp(1, s, p);
    cur.media.style.transform = p ? `translate(${tx}px, ${ty}px) scale(${sc})` : '';
    this.bottom.style.opacity = String(1 - p);
    this.bottom.style.pointerEvents = p > 0.5 ? 'none' : '';
    if (instant) { this.info.style.transform = `translateY(${Hs + 24}px)`; cur.media.style.transform = ''; this.infoQ = 0; }
  }

  setInfo(open, velocity = 0) {
    if (!this.isOpen) return;
    if (open && this.zoom.s > 1.01) this.animateZoom({ s: 1, x: 0, y: 0 });
    if (open && this.infoQ === 0) { this.renderInfo(); this.infoH = this.infoHeight(); }
    if (open) { clearTimeout(this.chromeTimer); this.setChrome(true); }
    this.infoAnim && this.infoAnim.stop();
    const to = open ? 1 : 0;
    if (reducedMotion.matches) { this.applyInfo(to); return; }
    const Hs = this.infoH || this.infoHeight();
    this.infoAnim = spring({
      from: this.infoQ, to, velocity: velocity ? -velocity / Hs : 0, response: 0.4, damping: velocity ? 0.88 : 1, precision: 0.001,
      onUpdate: (q) => this.applyInfo(q),
      onDone: () => { if (!open) this.scheduleChromeHide(); },
    });
  }

  bindInfoDrag() {
    const vel = new Velocity();
    let d = null;
    this.info.addEventListener('pointerdown', (e) => {
      const onGrab = e.target.closest('.sheet-grab');
      const scrollable = this.info.scrollHeight > this.info.clientHeight + 1;
      if (!onGrab && (scrollable || e.target.closest('button, a'))) return;
      d = { id: e.pointerId, y0: e.clientY, q0: this.infoQ, moved: false };
      vel.reset();
      vel.add(0, e.clientY);
      this.infoAnim && this.infoAnim.stop();
    });
    this.info.addEventListener('pointermove', (e) => {
      if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y0;
      if (!d.moved && Math.abs(dy) < 5) return;
      if (!d.moved) { try { this.info.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
      d.moved = true;
      vel.add(0, e.clientY);
      const Hs = this.infoH || this.infoHeight();
      let q = d.q0 - dy / Hs;
      if (q > 1) q = 1 + rubberband(q - 1, 1, 0.3);
      this.applyInfo(Math.max(0, q));
    });
    const up = (e) => {
      if (!d || e.pointerId !== d.id) return;
      const moved = d.moved;
      d = null;
      if (!moved) return;
      const { vy } = vel.get();
      const Hs = this.infoH || this.infoHeight();
      const rest = this.infoQ - project(vy, 0.99) / Hs;
      this.setInfo(rest > 0.5, vy);
    };
    this.info.addEventListener('pointerup', up);
    this.info.addEventListener('pointercancel', up);
  }

  // ── gestures ──────────────────────────────────────────────────────────────
  bindGestures() {
    const root = this.root;
    let g = null;
    const pts = this.pointers;
    const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
    const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };

    root.addEventListener('pointerdown', (e) => {
      if (!this.isOpen || this.closing) return;
      if (e.target.closest('.v-btn, .vc, .v-open, .v-info, .v-play, iframe, a')) return;
      if (e.button > 0) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      if (this.openAnim) this.openAnim.finish();
      if (pts.size === 2) {
        if (!this.zoomable()) return;
        if (g && g.mode === 'page') this.go(0);
        this.zoomAnim && this.zoomAnim.stop();
        g = { mode: 'pinch', d0: dist(), m0: mid(), z0: { ...this.zoom } };
        return;
      }
      if (pts.size > 2) return;
      // Grab a running page animation where it is.
      let trackFrom = this.trackX;
      if (this.pageAnim) {
        this.pageAnim.stop();
        this.pageAnim = null;
        const W = innerWidth + GAP;
        if (this.trackX < -W / 2 && this.index < this.items.length - 1) this.shift(1);
        else if (this.trackX > W / 2 && this.index > 0) this.shift(-1);
        trackFrom = this.trackX;
      }
      this.zoomAnim && this.zoomAnim.stop();
      g = { mode: null, x0: e.clientX, y0: e.clientY, t0: performance.now(), track0: trackFrom, z0: { ...this.zoom }, q0: this.infoQ, id: e.pointerId };
      this.vel.reset();
      this.vel.add(e.clientX, e.clientY);
    });

    root.addEventListener('pointermove', (e) => {
      if (!g || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.mode === 'pinch') {
        if (pts.size < 2) return;
        const f = this.cur.fitRect;
        let s = g.z0.s * (dist() / g.d0);
        if (s < 1) s = 1 - rubberband(1 - s, 1, 0.4);
        if (s > 5) s = 5 + rubberband(s - 5, 5, 0.3);
        const m = mid();
        const lx = (g.m0.x - f.left - g.z0.x) / g.z0.s;
        const ly = (g.m0.y - f.top - g.z0.y) / g.z0.s;
        this.setZoom({ s, x: m.x - f.left - lx * s, y: m.y - f.top - ly * s });
        return;
      }
      if (e.pointerId !== g.id) return;
      this.vel.add(e.clientX, e.clientY);
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      if (!g.mode) {
        if (Math.hypot(dx, dy) < 8) return;
        if (this.zoom.s > 1.01) g.mode = 'pan';
        else if (this.infoQ > 0.01) g.mode = Math.abs(dy) >= Math.abs(dx) ? 'info' : 'none';
        else if (Math.abs(dx) > Math.abs(dy) * 1.1) g.mode = 'page';
        else if (dy > 0) { g.mode = 'dismiss'; this.setChrome(false); if (this.cur.video) this.cur.video.pause(); }
        else g.mode = 'info';
        if (g.mode === 'info' && this.infoQ === 0) { this.renderInfo(); this.infoH = this.infoHeight(); }
        g.x0 = e.clientX; g.y0 = e.clientY;
        return;
      }
      const W = innerWidth;
      if (g.mode === 'page') {
        let x = g.track0 + dx;
        const atStart = this.index === 0 && x > 0, atEnd = this.index === this.items.length - 1 && x < 0;
        if (atStart || atEnd) x = Math.sign(x) * rubberband(Math.abs(x), W);
        this.setTrack(x);
      } else if (g.mode === 'dismiss') {
        this.applyDismiss(dx, dy);
      } else if (g.mode === 'info') {
        const Hs = this.infoH || this.infoHeight();
        let q = g.q0 - dy / Hs;
        if (q > 1) q = 1 + rubberband(q - 1, 1, 0.3);
        this.applyInfo(Math.max(0, q));
      } else if (g.mode === 'pan') {
        const { bx, by } = this.zoomBounds(this.zoom.s);
        const rb = (v, lo, hi, dim) => (v < lo ? lo - rubberband(lo - v, dim) : v > hi ? hi + rubberband(v - hi, dim) : v);
        this.setZoom({ s: this.zoom.s, x: rb(g.z0.x + dx, bx[0], bx[1], W), y: rb(g.z0.y + dy, by[0], by[1], innerHeight) });
      }
    });

    const up = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.mode === 'pinch') {
        if (pts.size === 0) { this.settleZoom(null); g = null; }
        else if (pts.size === 1) {
          // Continue as a pan with the remaining finger.
          const [p] = [...pts.entries()];
          g = { mode: this.zoom.s > 1.01 ? 'pan' : 'none', x0: p[1].x, y0: p[1].y, z0: { ...this.zoom }, id: p[0], t0: performance.now() };
          this.vel.reset();
        }
        return;
      }
      if (e.pointerId !== g.id) return;
      const { vx, vy } = this.vel.get();
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      const mode = g.mode;
      const tap = !mode && performance.now() - g.t0 < 400;
      g = null;
      if (tap) { this.handleTap(e.clientX, e.clientY); return; }
      if (mode === 'page') {
        const W = innerWidth + GAP;
        const rest = this.trackX + project(vx, 0.995);
        let dir = rest < -W / 2 ? 1 : rest > W / 2 ? -1 : 0;
        if (Math.abs(vx) > 350 && Math.sign(-vx) !== 0) dir = vx < 0 ? 1 : -1;
        if ((dir === 1 && this.index >= this.items.length - 1) || (dir === -1 && this.index <= 0)) dir = 0;
        this.go(dir, vx);
      } else if (mode === 'dismiss') {
        if ((dy > 110 && vy > -150) || vy > 650) this.close({ velocity: vy });
        else this.cancelDismiss(vy);
      } else if (mode === 'info') {
        const Hs = this.infoH || this.infoHeight();
        const rest = this.infoQ - project(vy, 0.99) / Hs;
        this.setInfo(rest > 0.45, vy);
      } else if (mode === 'pan') {
        this.settleZoom({ vx, vy });
      }
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
  }

  handleTap(x, y) {
    const it = this.cur.item;
    if (!it) return;
    if (this.infoQ > 0.5) { this.setInfo(false); return; }
    const now = performance.now();
    const zoomable = this.zoomable();
    if (zoomable && this.lastTap && now - this.lastTap.t < 300 && Math.hypot(x - this.lastTap.x, y - this.lastTap.y) < 40) {
      clearTimeout(this.tapTimer);
      this.lastTap = null;
      this.toggleZoomAt(x, y);
      return;
    }
    if (it.kind === 'video') {
      if (!this.chromeOn) { this.setChrome(true); return; }
      this.togglePlay();
      this.scheduleChromeHide();
      return;
    }
    this.lastTap = { t: now, x, y };
    clearTimeout(this.tapTimer);
    this.tapTimer = setTimeout(() => { this.lastTap = null; this.setChrome(!this.chromeOn); }, zoomable ? 260 : 0);
  }

  applyDismiss(dx, dy) {
    const vh = innerHeight;
    const cur = this.cur, f = cur.fitRect;
    const down = Math.max(0, dy);
    const s = 1 - Math.min(1, down / (vh * 0.9)) * 0.42;
    const y = dy >= 0 ? dy : -rubberband(-dy, vh, 0.35);
    const cx = (f.width * (1 - s)) / 2, cy = (f.height * (1 - s)) / 2;
    cur.media.style.transform = `translate(${dx + cx}px, ${y + cy}px) scale(${s})`;
    this.bg.style.opacity = String(1 - Math.min(1, down / (vh * 0.5)));
  }

  cancelDismiss(vy) {
    const cur = this.cur;
    const live = liveTransform(cur.media);
    const bg0 = Number(this.bg.style.opacity || 1);
    const rel = live.y ? clamp(-vy / live.y, -10, 10) : 0;
    spring({
      from: 0, to: 1, velocity: rel, response: 0.34, damping: 0.9, precision: 0.002,
      onUpdate: (p) => {
        cur.media.style.transform = `translate(${lerp(live.x, 0, p)}px, ${lerp(live.y, 0, p)}px) scale(${lerp(live.sx, 1, p)})`;
        this.bg.style.opacity = String(lerp(bg0, 1, p));
      },
      onDone: () => {
        cur.media.style.transform = '';
        this.setChrome(true);
        if (cur.video && cur.video.paused) cur.video.play().catch(() => {});
      },
    });
  }
}
