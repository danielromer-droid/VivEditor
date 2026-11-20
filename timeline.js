// timeline.js — the strip under the video: thumbnails, the parts you keep, and the playhead.
//
// The edit is a list of "segments": the parts of the original video you keep,
// in order, e.g. [{start: 0, end: 4.2}, {start: 6, end: 10}].
// Everything not inside a segment is cut out.

const MIN_LENGTH = 0.1; // seconds: a part can't be shorter than this

export class Timeline {
  constructor({ root, canvas, segmentsLayer, playhead, video, onChange, onSeek }) {
    this.root = root;
    this.canvas = canvas;
    this.layer = segmentsLayer;
    this.playheadEl = playhead;
    this.video = video;
    this.onChange = onChange;
    this.onSeek = onSeek;
    this.duration = 0;
    this.segments = [];
    this.selected = 0;
    this.thumbJob = 0;

    root.addEventListener('pointerdown', (e) => this.pointerDown(e));
    new ResizeObserver(() => this.drawThumbnails()).observe(root);
  }

  load(duration, file) {
    this.duration = duration;
    this.file = file;
    this.reset();
    this.thumbnails = [];
    this.makeThumbnails();
  }

  reset() {
    this.segments = [{ start: 0, end: this.duration }];
    this.selected = 0;
    this.render();
    this.onChange();
  }

  // ---- edit actions ----

  split(time) {
    const i = this.segments.findIndex((s) => time > s.start + MIN_LENGTH && time < s.end - MIN_LENGTH);
    if (i < 0) return false;
    const s = this.segments[i];
    this.segments.splice(i, 1, { start: s.start, end: time }, { start: time, end: s.end });
    this.selected = i + 1;
    this.render();
    this.onChange();
    return true;
  }

  deleteSelected() {
    if (this.segments.length <= 1) return false; // always keep at least one part
    this.segments.splice(this.selected, 1);
    this.selected = Math.min(this.selected, this.segments.length - 1);
    this.render();
    this.onChange();
    return true;
  }

  // Total length of the finished video.
  get editedDuration() {
    return this.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  }

  // ---- drawing ----

  pct(t) { return `${(t / this.duration) * 100}%`; }

  render() {
    const parts = [];
    let cursor = 0;
    this.segments.forEach((s, i) => {
      if (s.start > cursor) parts.push(`<div class="gap" style="left:${this.pct(cursor)};width:${this.pct(s.start - cursor)}"></div>`);
      parts.push(
        `<div class="segment${i === this.selected ? ' selected' : ''}" data-i="${i}" style="left:${this.pct(s.start)};width:${this.pct(s.end - s.start)}">` +
        `<div class="handle start" data-i="${i}" data-edge="start"></div>` +
        `<div class="handle end" data-i="${i}" data-edge="end"></div></div>`,
      );
      cursor = s.end;
    });
    if (cursor < this.duration) parts.push(`<div class="gap" style="left:${this.pct(cursor)};width:${this.pct(this.duration - cursor)}"></div>`);
    this.layer.innerHTML = parts.join('');
  }

  updatePlayhead() {
    if (this.duration) this.playheadEl.style.left = this.pct(this.video.currentTime);
  }

  // ---- touch / mouse ----

  timeAt(clientX) {
    const r = this.root.getBoundingClientRect();
    return Math.min(this.duration, Math.max(0, ((clientX - r.left) / r.width) * this.duration));
  }

  pointerDown(e) {
    if (!this.duration) return;
    e.preventDefault();
    this.root.setPointerCapture(e.pointerId);
    const handle = e.target.closest('.handle');

    let move;
    if (handle) {
      // Dragging a yellow handle changes where a part starts or ends.
      const i = Number(handle.dataset.i);
      const edge = handle.dataset.edge;
      this.selected = i;
      move = (ev) => {
        const s = this.segments[i];
        const t = this.timeAt(ev.clientX);
        if (edge === 'start') {
          const min = i > 0 ? this.segments[i - 1].end : 0;
          s.start = Math.min(Math.max(t, min), s.end - MIN_LENGTH);
          this.onSeek(s.start);
        } else {
          const max = i < this.segments.length - 1 ? this.segments[i + 1].start : this.duration;
          s.end = Math.max(Math.min(t, max), s.start + MIN_LENGTH);
          this.onSeek(s.end);
        }
        this.render();
        this.onChange();
      };
    } else {
      // Tapping elsewhere moves the playhead (and selects the part under it).
      move = (ev) => {
        const t = this.timeAt(ev.clientX);
        const i = this.segments.findIndex((s) => t >= s.start && t <= s.end);
        if (i >= 0 && i !== this.selected) { this.selected = i; this.render(); }
        this.onSeek(t);
      };
    }
    move(e);
    const up = () => {
      this.root.removeEventListener('pointermove', move);
      this.root.removeEventListener('pointerup', up);
      this.root.removeEventListener('pointercancel', up);
      this.onChange();
    };
    this.root.addEventListener('pointermove', move);
    this.root.addEventListener('pointerup', up);
    this.root.addEventListener('pointercancel', up);
  }

  // ---- thumbnails ----
  // A second, hidden video jumps to evenly spaced moments and we take a picture each time.

  async makeThumbnails() {
    const job = ++this.thumbJob;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = this.video.src;
    await new Promise((res) => { v.onloadeddata = res; v.onerror = res; });
    if (!v.videoWidth) return;

    const count = 16;
    const h = 72;
    const w = Math.round((v.videoWidth / v.videoHeight) * h);
    for (let k = 0; k < count; k++) {
      if (job !== this.thumbJob) return; // a new video was opened meanwhile
      const t = ((k + 0.5) / count) * this.duration;
      await new Promise((res) => {
        v.onseeked = res;
        setTimeout(res, 1500); // don't get stuck on a slow seek
        v.currentTime = t;
      });
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(v, 0, 0, w, h);
      this.thumbnails.push({ t, image: c });
      this.drawThumbnails();
    }
    v.removeAttribute('src');
    v.load();
  }

  drawThumbnails() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#26262e';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!this.thumbnails?.length || !this.duration) return;

    // Tile the strip with pictures; each tile shows the thumbnail closest to its time.
    const first = this.thumbnails[0].image;
    const tileW = (first.width / first.height) * c.height;
    for (let x = 0; x < c.width; x += tileW) {
      const t = ((x + tileW / 2) / c.width) * this.duration;
      let best = this.thumbnails[0];
      for (const th of this.thumbnails) if (Math.abs(th.t - t) < Math.abs(best.t - t)) best = th;
      ctx.drawImage(best.image, x, 0, tileW, c.height);
    }
  }
}
