// Frame-by-frame stepping for <video>.
//
// The web has no "next frame" call, so a step is a precise seek into the middle of the neighbouring
// frame. Three things make that exact:
//   1. The frame rate is measured, not guessed: requestVideoFrameCallback reports the timestamp
//      (mediaTime) of every frame that reaches the screen while the video plays.
//   2. Every step starts from the mediaTime of the frame that is on screen right now, never from
//      currentTime, so rounding or a first frame that doesn't start at 0 can't throw it off.
//   3. Every landing is confirmed the same way: by a frame callback whose presentationTime is later
//      than the moment the seek started (Chrome sends one after every seek, even when the frame doesn't
//      change). Callbacks from earlier seeks that arrive late are ignored. If the frame didn't change (a
//      frame held for longer than usual, or the end of the video) the step looks further instead of
//      silently doing nothing, and it never jumps over a frame to get there.
//   4. When no callback arrives in time (hidden page, slow phone, a seek waiting on the network) the
//      landing is unconfirmed: the frame on screen is then worked out from currentTime and the frame
//      rate. It never reads a missing callback as "the frame didn't change", and a step never starts
//      from a frame that doesn't hold currentTime (it asks again first).
// Taps are queued and applied one frame per seek: jumping several frames at once would be faster but
// can't be verified on videos whose frames are not evenly spaced.

export const HAS_RVFC = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

const COMMON = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
const EXACT = { 23.976: 24000 / 1001, 29.97: 30000 / 1001, 59.94: 60000 / 1001 };
const DEFAULT_FPS = 30;   // until measured, and where requestVideoFrameCallback is missing
const MIN_SAMPLES = 8;
const MAX_SAMPLES = 96;
const EPS = 0.0005;       // mediaTimes closer than this are the same frame
const END_PAD = 0.002;    // never seek onto the very end: a looping video could wrap
const FINE = 0.004;       // probe size while the frame rate is still unknown
const WAIT_MIN = 250;     // ms to wait for a seek's frame callback; adapts to the device, up to WAIT_MAX
const WAIT_MAX = 600;
const WAIT_UNKNOWN = 1000; // before the frame rate is known there is nothing to fall back on: wait, retry
const RETRIES_UNKNOWN = 5;
const NUDGE = 0.0001;     // a seek to the exact current time shows no new frame, so it gets no callback

const learned = new Map(); // item key -> { fps, label, firstT, lastT }

const tick = () => new Promise((resolve) => {
  const id = setTimeout(resolve, 60);
  requestAnimationFrame(() => { clearTimeout(id); resolve(); });
});

function once(el, type, ms) {
  return new Promise((resolve) => {
    const done = (ok) => { clearTimeout(id); el.removeEventListener(type, on); resolve(ok); };
    const on = () => done(true);
    const id = setTimeout(() => done(false), ms);
    el.addEventListener(type, on);
  });
}

/** Frame rate from a list of frame durations (seconds). Snaps to a common rate when within 2%. */
export function estimateFps(durations) {
  const s = [...durations].sort((a, b) => a - b);
  const median = s[s.length >> 1];
  const near = s.filter((x) => Math.abs(x - median) <= median * 0.12);
  const raw = near.length / near.reduce((a, b) => a + b, 0);
  let best = null;
  for (const rate of COMMON) {
    const exact = EXACT[rate] || rate;
    const err = Math.abs(exact - raw) / exact;
    if (err <= 0.02 && (!best || err < best.err)) best = { rate, exact, err };
  }
  return best ? { fps: best.exact, label: best.rate } : { fps: raw, label: Math.round(raw * 1000) / 1000 };
}

export class FrameStepper {
  constructor(video, { key = '', onUpdate = () => {} } = {}) {
    this.v = video;
    this.key = key;
    this.onUpdate = onUpdate;
    const c = learned.get(key);
    this.fps = c ? c.fps : DEFAULT_FPS;
    this.label = c ? c.label : DEFAULT_FPS;
    this.known = HAS_RVFC ? !!c : true;       // without rVFC the default is all we will ever have
    this.firstT = c && c.firstT != null ? c.firstT : null;
    this.lastT = c && c.lastT != null ? c.lastT : null;
    this.T = null;            // mediaTime of the frame on screen
    this.Tct = null;          // the currentTime that T was confirmed (or worked out) for
    this.exact = false;       // T is a real frame start, not an estimate
    this.frames = 0;          // frames seen so far (rVFC callbacks)
    this.samples = [];
    this.added = 0;
    this.measured = false;
    this.prev = null;
    this.seg = 0;             // when the current stretch of playback (or seek) began
    this.pending = 0;         // queued steps, signed
    this.busy = false;
    this.dirty = true;        // the position was changed by something other than a step
    this.epoch = 0;
    this.selfSeek = false;
    this.confirmed = false;   // the last seek was confirmed by a frame callback
    this.pt = 0;              // presentationTime of the newest frame callback accepted
    this.lat = 60;            // typical delay (ms) between 'seeked' and its frame callback
    this.gen = 0;
    this.handle = 0;
    this.armed = 0;
    this.cbAt = 0;
    this.dead = false;
    this.lastChange = performance.now();
    video._stepper = this;    // for debugging in devtools
    video.addEventListener('play', () => { this.seg = performance.now(); this.interrupt(); });
    video.addEventListener('pause', () => { this.seg = this.lastChange = performance.now(); });
    video.addEventListener('seeking', () => {
      this.seg = performance.now();
      if (this.selfSeek) return;
      // Moved by something else (scrub, loop): the old frame is gone. Until a callback reports the new
      // one, currentTime says where we are; anything presented before this seek is stale.
      this.T = null;
      this.Tct = null;
      this.exact = false;
      this.pt = this.seg;
      this.interrupt();
    });
    video.addEventListener('timeupdate', () => {
      // A lost callback ends its chain; while playing, start a new one so measuring carries on.
      const now = performance.now();
      if (HAS_RVFC && !video.paused && now - Math.max(this.cbAt, this.armed) > 400) this.rearm();
    });
    if (HAS_RVFC) this.watch();
  }

  get d() { return 1 / this.fps; }

  destroy() {
    this.dead = true;
    this.pending = 0;
    this.epoch++;
  }

  /** Something else moved the playhead (play, scrub): drop queued steps and re-read the position. */
  interrupt() {
    this.pending = 0;
    this.dirty = true;
    this.epoch++;
  }

  save() {
    if (this.key) learned.set(this.key, { fps: this.fps, label: this.label, firstT: this.firstT, lastT: this.lastT });
  }

  // ── measuring ───────────────────────────────────────────────────────────────
  watch() {
    const v = this.v;
    const gen = ++this.gen;
    this.armed = performance.now();
    const onFrame = (now, meta) => {
      if (this.dead) return;
      if (gen === this.gen) this.handle = v.requestVideoFrameCallback(onFrame);   // a replaced chain just ends
      this.frame(now, meta);
    };
    this.handle = v.requestVideoFrameCallback(onFrame);
  }

  frame(now, meta) {
    this.cbAt = performance.now();
    const pt = typeof meta.presentationTime === 'number' ? meta.presentationTime : now;
    if (pt <= this.pt) return;                   // delivered late and out of order: older than what we know
    this.pt = pt;
    const t = meta.mediaTime;
    this.frames++;
    this.lastChange = performance.now();
    const p = this.prev;
    if (p && p.pt >= this.seg && pt >= this.seg) {   // both frames from the same stretch of playback
      const dt = t - p.t;
      let n = meta.presentedFrames - p.n;        // >1 when the screen is slower or callbacks come late
      if (!(n >= 1)) n = dt < 0.25 ? 1 : 0;
      if (n <= 240 && dt > 0.002 && dt < 4) {
        const f = dt / n;
        if (f > 1 / 121 && f < 1 / 7) this.sample(f, Math.min(n, 3));   // a long span is an average: worth more
      }
    }
    this.prev = { t, n: meta.presentedFrames, pt };
    this.T = t;
    this.Tct = null;
    this.exact = true;
    this.onUpdate();
  }

  /** Start a fresh callback chain (a lost callback would otherwise end the old one). */
  rearm() {
    try { this.v.cancelVideoFrameCallback(this.handle); } catch { /* ignore */ }
    this.watch();
  }

  sample(dt, weight = 1) {
    const s = this.samples;
    for (let i = 0; i < weight; i++) s.push(dt);
    while (s.length > MAX_SAMPLES) s.shift();
    this.added += weight;
    if (s.length < MIN_SAMPLES || (this.measured && this.added < 8)) return;
    this.added = 0;
    this.measured = true;
    const e = estimateFps(s);
    this.fps = e.fps;
    this.label = e.label;
    this.known = true;
    this.save();
  }

  /** One observed step is enough for a first estimate; playback refines it later. */
  provision(dt) {
    if (this.known || !(dt > 0.002 && dt < 0.25)) return;
    const e = estimateFps([dt]);
    this.fps = e.fps;
    this.label = e.label;
    this.known = true;
    this.save();
  }

  // ── reading ─────────────────────────────────────────────────────────────────
  /** Start time of the frame on screen. */
  pos() {
    if (this.T != null) return this.T;
    return Math.floor(this.v.currentTime * this.fps + 0.01) / this.fps;
  }

  atStart() {
    const T = this.pos();
    return this.firstT != null ? T <= this.firstT + EPS : T < FINE;
  }

  atEnd() {
    const T = this.pos();
    if (this.lastT != null) return T >= this.lastT - EPS;
    return this.known && isFinite(this.v.duration) && T + this.d >= this.v.duration - END_PAD;
  }

  /** m:ss:ff, where ff counts frames within the second (non-drop-frame). */
  timecode() {
    const base = Math.max(1, Math.round(this.fps));
    const n = Math.max(0, Math.round((this.pos() - (this.firstT || 0)) * this.fps));
    const s = Math.floor(n / base);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}:${String(n % base).padStart(2, '0')}`;
  }

  // ── stepping ────────────────────────────────────────────────────────────────
  /** Queue one frame forward (+1) or back (-1). Pauses the video. */
  step(dir) {
    const v = this.v;
    if (this.dead || v.readyState < 1 || !isFinite(v.duration)) return;
    if (!v.paused) {
      v.pause();
      this.dirty = true;
      this.lastChange = performance.now();
    }
    this.pending += dir < 0 ? -1 : 1;
    this.run();
  }

  /** Resolves when every queued step has landed. */
  async idle() {
    while (this.busy) await tick();
  }

  async run() {
    if (this.busy) return;
    this.busy = true;
    const v = this.v;
    try {
      for (let guard = 0; this.pending && !this.dead && guard < 2000; guard++) {
        const epoch = this.epoch;
        if (this.dirty) {
          await this.settle(epoch);
          if (epoch !== this.epoch) continue;   // interrupted meanwhile: the queue is already empty
          this.dirty = false;
        }
        if (!v.paused) { this.pending = 0; break; }
        const dir = Math.sign(this.pending);
        if (dir < 0 ? this.atStart() : this.atEnd()) { this.pending = 0; break; }   // no wrap at either end
        this.pending -= dir;
        const from = this.pos();
        const at = dir > 0 ? await this.forward(from, epoch) : await this.backward(from, epoch);
        if (at === null) {                      // interrupted, or the seek never finished
          if (epoch === this.epoch) { this.pending = 0; this.dirty = true; }
          break;
        }
        if (Math.abs(at - from) <= EPS) { this.pending = 0; break; }                 // found the first/last frame
        this.onUpdate();
      }
    } finally {
      this.busy = false;
      this.onUpdate();
    }
  }

  /** Make sure T is the frame on screen (a frame decoded just before pause can still arrive). */
  async settle(epoch) {
    const v = this.v;
    if (v.seeking) await once(v, 'seeked', 3000);
    if (!HAS_RVFC) return;
    if (performance.now() - this.lastChange <= 90) {
      let quiet = 0;
      let last = this.frames;
      for (let i = 0; i < 8 && quiet < 2; i++) {
        await tick();
        if (this.frames === last) quiet++;
        else { quiet = 0; last = this.frames; }
      }
    }
    // The frame on screen always holds currentTime. If the last frame we heard of doesn't (callbacks
    // running late or lost), ask again with a seek to where we already are.
    const ct = v.currentTime;
    const T = this.T;
    if (T != null && (this.Tct === ct || (this.known && T <= ct + EPS && ct - T < 1.02 * this.d))) return;
    const at = await this.seek(ct, epoch);
    if (at === null || this.confirmed) return;
    this.T = this.known ? this.frameAt(ct) : ct;
    this.exact = this.known;
    this.Tct = ct;
  }

  frameAt(time) { return Math.floor(time * this.fps + 1e-4) / this.fps; }

  /** Seek, then report the mediaTime of the frame that actually reached the screen. */
  async seek(t, epoch) {
    const v = this.v;
    // Until the frame rate is known an unconfirmed landing can't be worked out, so try again instead.
    const tries = HAS_RVFC && !this.known ? RETRIES_UNKNOWN : 1;
    const cap = isFinite(v.duration) ? v.duration - END_PAD : Infinity;
    for (let k = 0; k < tries; k++) {
      let to = Math.min(cap, t + 2 * k * NUDGE);        // a retry must change the time to get a callback
      if (to === v.currentTime) to = to + NUDGE <= cap ? to + NUDGE : to - NUDGE;
      const started = performance.now();
      if (HAS_RVFC) this.rearm();              // a fresh request, so a lost callback can't leave this seek unheard
      this.selfSeek = true;
      const landed = once(v, 'seeked', 5000);
      try { v.currentTime = to; } catch { this.selfSeek = false; return null; }
      const ok = await landed;
      this.selfSeek = false;
      if (!ok || this.dead || epoch !== this.epoch) return null;
      if (!HAS_RVFC) {
        this.confirmed = true;
        this.T = this.frameAt(v.currentTime);
        return this.T;
      }
      const t0 = performance.now();
      const wait = this.known ? Math.min(WAIT_MAX, Math.max(WAIT_MIN, this.lat * 2.5 + 120)) : WAIT_UNKNOWN;
      while (this.pt < started && performance.now() - t0 < wait) await tick();
      if (this.dead || epoch !== this.epoch) return null;
      this.confirmed = this.pt >= started;
      if (this.confirmed) {
        this.lat = this.lat * 0.7 + (performance.now() - t0) * 0.3;
        this.Tct = v.currentTime;
        return this.T;
      }
      this.lat = Math.min(WAIT_MAX, this.lat * 1.5 + 60);
      this.pt = started;                       // anything presented before this seek is stale from now on
    }
    // No callback in time. The old frame proves nothing: callers work the landing out from currentTime.
    this.T = null;
    this.exact = false;
    return this.pos();
  }

  /** Landing we couldn't confirm: the frame that holds currentTime, from the frame rate. */
  assume(from, dir) {
    const v = this.v;
    let at;
    if (this.known) {
      at = this.frameAt(v.currentTime);
      if (dir > 0 ? at <= from + EPS : at >= from - EPS) at = from;   // didn't get anywhere
    } else {
      at = from + dir * this.d;                // rough: the rate is still a guess
      if (dir > 0 && at >= v.duration - END_PAD) at = from;
      if (dir < 0 && at < (this.firstT != null ? this.firstT : 0) - EPS) at = from;
    }
    this.T = at;
    this.exact = this.known;
    this.Tct = v.currentTime;
    return at;
  }

  // A boundary is only remembered when a frame callback proved that nothing changed.
  setFirst(T) { if (this.confirmed) { this.firstT = T; this.save(); } return T; }
  setLast(T) { if (this.confirmed) { this.lastT = T; this.save(); } return T; }

  async forward(from, epoch) {
    const d = this.d;
    const fromExact = this.exact;
    const cap = this.v.duration - END_PAD;
    let target = from + 1.5 * d;                             // the middle of the next frame
    if (target > cap) {
      if (this.known && cap <= from + d + END_PAD) return from;   // no room for another frame
      target = this.known ? (from + d + cap) / 2 : cap;
    }
    const at = await this.seek(target, epoch);
    if (at === null) return null;
    if (!this.confirmed) return this.assume(from, 1);
    if (at < from - EPS) return null;                        // (went backwards: start over from a clean read)
    if (at <= from + EPS) return this.findNext(from, target, epoch);   // the same frame is still up
    if (!this.known) {                                       // unmeasured video: prove it is the very next frame
      const next = await this.narrow(from, from, at, at, epoch);
      if (next !== null && fromExact && this.exact) this.provision(next - from);
      return next;
    }
    if (at - from > 1.3 * d) return this.narrow(from, from, at, at, epoch);   // a shorter frame may sit in between
    return at;
  }

  /** The same frame is still showing: nudge once, then look further ahead (held frame, or end of video). */
  async findNext(from, sameAt, epoch) {
    const d = this.d;
    const cap = this.v.duration - END_PAD;
    let lo = sameAt;
    for (const o of [1.75, 2.5, 4.5, 8.5, 16.5, 32.5, 64.5, 128.5, Infinity]) {
      const t = Math.min(from + o * d, cap);
      if (t <= lo + 0.0001) break;
      const at = await this.seek(t, epoch);
      if (at === null) return null;
      if (!this.confirmed) return this.assume(from, 1);
      if (at > from + EPS) return this.narrow(from, lo, at, at, epoch);
      lo = t;
    }
    return this.setLast(from);                               // nothing comes after this frame
  }

  /**
   * Time `lo` still shows frame `from`; a later frame starts at `hi`. Halve the gap until no frame
   * can hide in between, then make sure the earliest later frame is the one on screen.
   */
  async narrow(from, lo, hi, shown, epoch) {
    const gap = this.known ? 0.5 * this.d : FINE;
    let lost = false;
    for (let i = 0; i < 14 && hi - lo > gap; i++) {
      const mid = (lo + hi) / 2;
      const at = await this.seek(mid, epoch);
      if (at === null) return null;
      if (!this.confirmed) { lost = true; break; }           // keep the earliest later frame we did see
      shown = at;
      if (at > from + EPS) hi = Math.min(hi, at);
      else lo = mid;
    }
    if (lost || Math.abs(shown - hi) > EPS) {                // put that frame on screen
      const at = await this.seek(hi + Math.min(gap / 2, END_PAD), epoch);
      if (at === null) return null;
      if (this.confirmed) return at;
      this.T = hi;                                           // a frame start a callback did report
      this.exact = true;
      this.Tct = this.v.currentTime;
    }
    return hi;
  }

  async backward(from, epoch) {
    const d = this.d;
    // Just before this frame starts, the previous one is on screen. Half a frame back lands mid-frame;
    // the 12 ms cap keeps that true even if the measured rate is half the real one.
    const fromExact = this.exact;
    let at = await this.seek(Math.max(0, from - (this.known ? Math.min(0.5 * d, 0.012) : FINE)), epoch);
    if (at === null) return null;
    if (!this.confirmed) return this.assume(from, -1);
    if (at > from + EPS) return null;                        // (went forwards: start over from a clean read)
    if (at >= from - EPS) {                                  // same frame: nudge once, else this is the first frame
      at = await this.seek(Math.max(0, from - (this.known ? 0.75 * d : 3 * FINE)), epoch);
      if (at === null) return null;
      if (!this.confirmed) return this.assume(from, -1);
      if (at >= from - EPS) return this.setFirst(from);
      return at;
    }
    if (fromExact) this.provision(from - at);
    return at;
  }
}
