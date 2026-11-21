// render.js — stacks all the layers into the final picture.
//
// For each layer, from the bottom up:
//   1. draw the layer alone on a scratch canvas (an adjustment layer instead takes
//      a copy of everything below and changes its colors),
//   2. cut it with its mask (white = show, empty = hide),
//   3. if it is "clipped", cut it again with the shape of the layer below,
//   4. paint it onto the result with the layer's opacity and blend mode.
//
// To stay fast while you drag a slider or paint, we remember the result of all the
// layers below the one you are working on, and only redraw from that layer up.

import { ADJUSTMENTS } from './adjust.js';
import { makeCanvas, freeCanvas, layerMatrix } from './doc.js';

// ---- text layers are drawn to their own little canvas ----
export function textCanvas(L) {
  const key = JSON.stringify([L.text, L.font, L.size, L.color, L.bold, L.italic, L.align, L.lineHeight]);
  if (L._key === key && L._canvas) return L._canvas;
  const font = `${L.italic ? 'italic ' : ''}${L.bold ? '700' : '400'} ${L.size}px ${L.font}`;
  const measure = makeCanvas(1, 1).getContext('2d');
  measure.font = font;
  const lines = String(L.text || ' ').split('\n');
  const widths = lines.map((t) => measure.measureText(t).width);
  const pad = Math.ceil(L.size * 0.25);
  const lineH = L.size * L.lineHeight;
  const w = Math.ceil(Math.max(1, ...widths)) + pad * 2;
  const h = Math.ceil(lines.length * lineH) + pad * 2;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = L.color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = L.align;
  const x = L.align === 'left' ? pad : L.align === 'right' ? w - pad : w / 2;
  lines.forEach((t, i) => ctx.fillText(t, x, pad + lineH * (i + 0.5)));
  L._key = key;
  L._canvas = c;
  return c;
}

// The layer's own pixels (before position/scale/rotation).
export function layerSource(L) {
  if (L.type === 'image') return L.canvas;
  if (L.type === 'text') return textCanvas(L);
  return null;
}

// Where the layer's 4 corners land in the picture.
export function layerCorners(L) {
  const src = layerSource(L);
  if (!src) return null;
  const m = layerMatrix(L, src.width, src.height);
  return [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]].map(([x, y]) => {
    const p = m.transformPoint(new DOMPoint(x, y));
    return [p.x, p.y];
  });
}

export class Renderer {
  constructor() {
    this.cacheSig = '';
  }

  ensure(name, w, h) {
    let c = this[name];
    if (!c || c.width !== w || c.height !== h) {
      freeCanvas(c);
      c = this[name] = makeCanvas(w, h);
    }
    return c;
  }

  // The brush stroke being painted right now, limited to the selection.
  liveStroke(doc) {
    const live = doc.live;
    if (!doc.selection) return live.canvas;
    const t = this.ensure('strokeTmp', doc.width, doc.height);
    const ctx = t.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(live.canvas, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(doc.selection, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return t;
  }

  // What the stroke adds to the layer: brush color, copied pixels (clone),
  // or a see-through purple preview (healing happens when you let go).
  liveContent(doc) {
    const live = doc.live;
    const stroke = this.liveStroke(doc);
    if (live.mode !== 'clone' && live.mode !== 'heal') return stroke;
    const t = this.ensure('cloneTmp', doc.width, doc.height);
    const ctx = t.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    if (live.mode === 'clone') {
      ctx.drawImage(live.fill, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(stroke, 0, 0);
    } else {
      ctx.drawImage(stroke, 0, 0);
      ctx.globalCompositeOperation = 'source-in';
      ctx.fillStyle = 'rgba(123,108,255,0.55)';
      ctx.fillRect(0, 0, t.width, t.height);
    }
    ctx.globalCompositeOperation = 'source-over';
    return t;
  }

  drawContent(L, ctx, doc) {
    const src = layerSource(L);
    ctx.setTransform(layerMatrix(L, src.width, src.height));
    ctx.drawImage(src, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (doc.live && doc.live.layerId === L.id && doc.live.target === 'layer') {
      ctx.globalAlpha = doc.live.opacity;
      ctx.globalCompositeOperation = doc.live.mode === 'erase' ? 'destination-out' : 'source-over';
      ctx.drawImage(this.liveContent(doc), 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  maskOf(L, doc) {
    if (!(doc.live && doc.live.layerId === L.id && doc.live.target === 'mask')) return L.mask;
    const m = this.ensure('maskTmp', doc.width, doc.height);
    const ctx = m.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(L.mask, 0, 0);
    ctx.globalAlpha = doc.live.opacity;
    ctx.globalCompositeOperation = doc.live.mode === 'hide' ? 'destination-out' : 'source-over';
    ctx.drawImage(this.liveStroke(doc), 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return m;
  }

  /** Draws the whole picture and returns a canvas the size of the document. */
  render(doc, { useCache = true } = {}) {
    const w = doc.width;
    const h = doc.height;
    const layers = doc.layers;
    const acc = this.ensure('acc', w, h);
    const actx = acc.getContext('2d');
    const tmp = this.ensure('tmp', w, h);
    const tctx = tmp.getContext('2d', { willReadFrequently: false });
    const needBase = layers.some((l) => l.clip);
    const base = needBase ? this.ensure('base', w, h) : null;
    const bctx = base && base.getContext('2d');

    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.globalAlpha = 1;
    actx.globalCompositeOperation = 'source-over';
    actx.clearRect(0, 0, w, h);

    // Can we reuse the layers below the active one?
    const k = doc.activeIndex;
    let start = 0;
    let sig = '';
    if (useCache && k > 0 && !layers[k].clip) {
      sig = `${w}x${h}|` + layers.slice(0, k).map((l) => `${l.id}:${l.rev}:${l.visible ? 1 : 0}`).join(',');
      if (sig === this.cacheSig && this.cache && this.cache.width === w && this.cache.height === h) {
        actx.drawImage(this.cache, 0, 0);
        start = k;
      }
    }

    let baseVisible = false;
    for (let i = start; i < layers.length; i++) {
      if (i === k && start === 0 && sig) {
        const cache = this.ensure('cache', w, h);
        const cctx = cache.getContext('2d');
        cctx.globalCompositeOperation = 'copy';
        cctx.drawImage(acc, 0, 0);
        cctx.globalCompositeOperation = 'source-over';
        this.cacheSig = sig;
      }

      const L = layers[i];
      const clipped = L.clip && i > 0;
      if (!L.visible) { if (!clipped) baseVisible = false; continue; }
      if (clipped && !baseVisible) continue;

      tctx.setTransform(1, 0, 0, 1, 0, 0);
      tctx.globalAlpha = 1;
      tctx.globalCompositeOperation = 'source-over';
      tctx.clearRect(0, 0, w, h);

      if (L.type === 'adjust') {
        tctx.drawImage(acc, 0, 0);
        const img = tctx.getImageData(0, 0, w, h);
        ADJUSTMENTS[L.kind].apply(img.data, w, h, L.params, tmp);
        tctx.putImageData(img, 0, 0);
      } else {
        this.drawContent(L, tctx, doc);
      }

      const mask = L.mask ? this.maskOf(L, doc) : null;
      if (mask) {
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(mask, 0, 0);
      }
      if (clipped) {
        tctx.globalCompositeOperation = 'destination-in';
        tctx.drawImage(base, 0, 0);
      } else if (base) {
        // remember this layer's shape for clipped layers above it
        bctx.globalCompositeOperation = 'copy';
        if (L.type === 'adjust') {
          if (mask) bctx.drawImage(mask, 0, 0);
          else { bctx.fillStyle = '#fff'; bctx.fillRect(0, 0, w, h); }
        } else {
          bctx.drawImage(tmp, 0, 0);
        }
        bctx.globalCompositeOperation = 'source-over';
        baseVisible = true;
      }
      tctx.globalCompositeOperation = 'source-over';

      actx.globalAlpha = L.opacity;
      actx.globalCompositeOperation = L.blend;
      actx.drawImage(tmp, 0, 0);
      actx.globalAlpha = 1;
      actx.globalCompositeOperation = 'source-over';
    }
    return acc;
  }
}

// Small preview picture of one layer for the layers panel.
export function layerThumb(L, doc, size = 40) {
  const s = size / Math.max(doc.width, doc.height);
  const c = makeCanvas(Math.max(1, doc.width * s), Math.max(1, doc.height * s));
  const ctx = c.getContext('2d');
  const src = layerSource(L);
  if (src) {
    ctx.setTransform(new DOMMatrix().scale(s, s).multiply(layerMatrix(L, src.width, src.height)));
    ctx.drawImage(src, 0, 0);
  }
  return c;
}

export function maskThumb(L, doc, size = 40) {
  const s = size / Math.max(doc.width, doc.height);
  const c = makeCanvas(Math.max(1, doc.width * s), Math.max(1, doc.height * s));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(L.mask, 0, 0, c.width, c.height);
  return c;
}
