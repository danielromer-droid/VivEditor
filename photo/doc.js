// doc.js — the picture you are editing: its size, its layers, the selection, and undo/redo.
//
// A layer is a plain object. Every layer has:
//   id, type ('image' | 'text' | 'adjust'), name, visible, opacity (0..1),
//   blend (a canvas blend mode such as 'multiply'), clip (true = only shows where
//   the layer below has pixels), mask (a canvas the size of the picture, or null),
//   rev (changes each time the layer changes, so the renderer knows what to redraw).
// Image layers also have `canvas` (their pixels) and `tf` (position, scale, rotation).
// Text layers have their text settings and `tf`. Adjustment layers have `kind` and `params`.
//
// Undo works with "snapshots": before each change we save a light copy of the layer list.
// Pixel canvases are never changed in place: an edit makes a new canvas (see editCanvas),
// so old snapshots still point at the old pixels.

let lastId = 0;
let lastRev = 0;
export const newRev = () => ++lastRev;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function cloneCanvas(c) {
  const n = makeCanvas(c.width, c.height);
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}

// Frees a canvas' memory right away (helps a lot on iPhone).
export function freeCanvas(c) {
  if (c) { c.width = 0; c.height = 0; }
}

const isPhone = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 820;
export const MAX_SIDE = isPhone ? 2560 : 4096; // bigger pictures are scaled down to stay fast
const MAX_UNDO = isPhone ? 15 : 40;

export function baseLayer(type, name) {
  return {
    id: ++lastId,
    type,
    name,
    visible: true,
    opacity: 1,
    blend: 'source-over',
    clip: false,
    mask: null,
    rev: newRev(),
  };
}

export class Doc {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layers = []; // bottom first
    this.activeId = null;
    this.target = 'layer'; // 'layer' or 'mask': what brushes paint on
    this.selection = null; // canvas: opaque where selected
    this.selectionRev = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.dragging = false; // true while a slider or handle is being dragged
  }

  // ----- events -----
  on(fn) { this.listeners.add(fn); }
  emit(kind = 'pixels') { for (const fn of this.listeners) fn(kind); }

  // ----- layers -----
  get active() { return this.layers.find((l) => l.id === this.activeId) || null; }
  get activeIndex() { return this.layers.findIndex((l) => l.id === this.activeId); }

  touch(layer) { layer.rev = newRev(); }

  addLayer(layer, { above = this.active } = {}) {
    const i = above ? this.layers.indexOf(above) + 1 : this.layers.length;
    this.layers.splice(i, 0, layer);
    this.activeId = layer.id;
    this.target = 'layer';
    return layer;
  }

  newImageLayer(canvas, name = 'Layer') {
    const layer = baseLayer('image', name);
    layer.canvas = canvas;
    layer.tf = { cx: this.width / 2, cy: this.height / 2, sx: 1, sy: 1, rot: 0 };
    return layer;
  }

  removeLayer(layer) {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    this.layers.splice(i, 1);
    const next = this.layers[Math.min(i, this.layers.length - 1)] || this.layers[i - 1];
    this.activeId = next ? next.id : null;
    this.target = 'layer';
  }

  moveLayer(layer, delta) {
    const i = this.layers.indexOf(layer);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.layers.length) return false;
    this.layers.splice(i, 1);
    this.layers.splice(j, 0, layer);
    return true;
  }

  // Replace one of a layer's canvases with an edited copy (keeps undo working).
  editCanvas(layer, which, draw) {
    const copy = cloneCanvas(layer[which]);
    const ctx = copy.getContext('2d');
    draw(ctx, copy);
    layer[which] = copy;
    this.touch(layer);
    return copy;
  }

  // ----- undo / redo -----
  snapshot() {
    return {
      width: this.width,
      height: this.height,
      activeId: this.activeId,
      target: this.target,
      selection: this.selection,
      layers: this.layers.map(copyLayer),
    };
  }

  restore(s) {
    this.width = s.width;
    this.height = s.height;
    this.activeId = s.activeId;
    this.target = s.target;
    this.selection = s.selection;
    this.selectionRev++;
    this.layers = s.layers.map(copyLayer);
  }

  // Call this BEFORE changing anything that should be undoable.
  checkpoint() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.snapshot());
    this.restore(this.undoStack.pop());
    this.emit('structure');
    return true;
  }

  redo() {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.snapshot());
    this.restore(this.redoStack.pop());
    this.emit('structure');
    return true;
  }

  // ----- selection -----
  setSelection(canvas) {
    this.selection = canvas;
    this.selectionRev++;
  }

  // ----- crop: keep only the rectangle x,y,w,h -----
  crop(x, y, w, h) {
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
    for (const l of this.layers) {
      if (l.tf) l.tf = { ...l.tf, cx: l.tf.cx - x, cy: l.tf.cy - y };
      if (l.mask) {
        const m = makeCanvas(w, h);
        const mctx = m.getContext('2d');
        mctx.fillStyle = '#fff';
        mctx.fillRect(0, 0, w, h); // areas outside the old picture stay visible
        mctx.globalCompositeOperation = 'destination-out';
        mctx.fillRect(-x, -y, this.width, this.height);
        mctx.globalCompositeOperation = 'source-over';
        mctx.drawImage(l.mask, -x, -y);
        l.mask = m;
      }
      this.touch(l);
    }
    this.width = w;
    this.height = h;
    this.setSelection(null);
  }
}

function copyLayer(l) {
  const c = { ...l };
  if (l.tf) c.tf = { ...l.tf };
  if (l.params) c.params = structuredClone(l.params);
  return c;
}

// The matrix that places a layer's own pixels (w × h) into the picture.
export function layerMatrix(layer, w, h) {
  const { cx, cy, sx, sy, rot } = layer.tf;
  return new DOMMatrix()
    .translate(cx, cy)
    .rotate(rot)
    .scale(sx, sy)
    .translate(-w / 2, -h / 2);
}
