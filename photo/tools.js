// tools.js — what happens when you press, drag and release on the picture.
//
// Every tool is an object with optional functions:
//   down(p, e), move(p, e), up(p, e)  — p is the point in picture pixels {x, y}
//   hover(p)                          — mouse moving without pressing
//   overlay(ctx)                      — draws guides (handles, outlines…) on top
// `app` (from photo.js) gives access to the document and the screen.

import { baseLayer, makeCanvas, freeCanvas, layerMatrix } from './doc.js';
import { layerCorners, layerSource } from './render.js';
import { shapeSelection, magicWand, combine } from './selection.js';
import { heal } from './heal.js';

export const FONTS = [
  ['system-ui, sans-serif', 'Sans serif'],
  ['Georgia, "Times New Roman", serif', 'Serif'],
  ['"Courier New", monospace', 'Typewriter'],
  ['Impact, "Arial Black", sans-serif', 'Impact'],
  ['"Comic Sans MS", "Chalkboard SE", cursive', 'Comic'],
  ['"Brush Script MT", "Snell Roundhand", cursive', 'Script'],
];

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ---------------------------------------------------------------- Move / transform
function makeMoveTool(app) {
  let drag = null;

  function handles(L) {
    const corners = layerCorners(L).map(([x, y]) => app.toScreen(x, y));
    const top = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
    const center = { x: (corners[0].x + corners[2].x) / 2, y: (corners[0].y + corners[2].y) / 2 };
    // rotation handle: 30px beyond the top edge, away from the center
    const dx = top.x - center.x; const dy = top.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    const rot = { x: top.x + (dx / len) * 30, y: top.y + (dy / len) * 30 };
    return { corners, top, rot, center };
  }

  return {
    name: 'move',
    cursor: 'move',
    start(p, e, L) {
      const s = app.toScreen(p.x, p.y);
      const hd = handles(L);
      const near = (q) => Math.hypot(q.x - s.x, q.y - s.y) < (e.pointerType === 'touch' ? 26 : 14);
      let mode = 'move';
      if (near(hd.rot)) mode = 'rotate';
      else if (hd.corners.some(near)) mode = 'scale';
      drag = { mode, p0: p, tf0: { ...L.tf }, L, changed: false };
    },
    down(p, e) {
      const L = app.doc.active;
      if (!L || !L.tf) { app.toast('Choose an image or text layer to move it.'); return; }
      this.start(p, e, L);
    },
    move(p, e) {
      if (!drag) return;
      const { L, tf0, p0 } = drag;
      if (!drag.changed) { app.doc.checkpoint(); drag.changed = true; }
      const c = { x: tf0.cx, y: tf0.cy };
      if (drag.mode === 'move') {
        L.tf.cx = tf0.cx + p.x - p0.x;
        L.tf.cy = tf0.cy + p.y - p0.y;
      } else if (drag.mode === 'scale') {
        const f = Math.max(0.01, dist(p, c) / Math.max(1, dist(p0, c)));
        L.tf.sx = tf0.sx * f;
        L.tf.sy = tf0.sy * f;
      } else {
        let a = tf0.rot + (Math.atan2(p.y - c.y, p.x - c.x) - Math.atan2(p0.y - c.y, p0.x - c.x)) * 180 / Math.PI;
        if (e.shiftKey) a = Math.round(a / 15) * 15;
        L.tf.rot = ((a % 360) + 540) % 360 - 180;
      }
      app.doc.touch(L);
      app.changed('pixels');
    },
    up() {
      if (drag && drag.changed) app.changed('commit');
      drag = null;
    },
    overlay(ctx) {
      const L = app.doc.active;
      if (!L || !L.tf || !L.visible) return;
      const { corners, top, rot } = handles(L);
      ctx.strokeStyle = '#7b6cff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      corners.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(rot.x, rot.y);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const q of corners) { ctx.fillRect(q.x - 5, q.y - 5, 10, 10); ctx.strokeRect(q.x - 5, q.y - 5, 10, 10); }
      ctx.beginPath();
      ctx.arc(rot.x, rot.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    },
  };
}

// ---------------------------------------------------------------- Crop
function makeCropTool(app) {
  let rect = null; // {x, y, w, h} in picture pixels
  let drag = null;
  const norm = (r) => ({
    x: Math.max(0, Math.min(r.x, r.x + r.w)),
    y: Math.max(0, Math.min(r.y, r.y + r.h)),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  });
  return {
    name: 'crop',
    cursor: 'crosshair',
    get rect() { return rect; },
    activate() { rect = { x: 0, y: 0, w: app.doc.width, h: app.doc.height }; },
    deactivate() { rect = null; },
    down(p) {
      if (rect && p.x > rect.x && p.y > rect.y && p.x < rect.x + rect.w && p.y < rect.y + rect.h && !(rect.w === app.doc.width && rect.h === app.doc.height)) {
        drag = { mode: 'move', p0: p, r0: { ...rect } };
      } else {
        drag = { mode: 'new', p0: p };
        rect = { x: p.x, y: p.y, w: 0, h: 0 };
      }
    },
    move(p) {
      if (!drag) return;
      const W = app.doc.width; const H = app.doc.height;
      if (drag.mode === 'move') {
        rect.x = Math.min(W - rect.w, Math.max(0, drag.r0.x + p.x - drag.p0.x));
        rect.y = Math.min(H - rect.h, Math.max(0, drag.r0.y + p.y - drag.p0.y));
      } else {
        const x = Math.min(W, Math.max(0, p.x)); const y = Math.min(H, Math.max(0, p.y));
        rect = norm({ x: drag.p0.x, y: drag.p0.y, w: x - drag.p0.x, h: y - drag.p0.y });
      }
      app.changed('overlay');
    },
    up() {
      drag = null;
      if (rect && (rect.w < 2 || rect.h < 2)) rect = { x: 0, y: 0, w: app.doc.width, h: app.doc.height };
      app.changed('overlay');
    },
    apply() {
      if (!rect || rect.w < 2 || rect.h < 2) return;
      app.doc.checkpoint();
      app.doc.crop(rect.x, rect.y, rect.w, rect.h);
      rect = { x: 0, y: 0, w: app.doc.width, h: app.doc.height };
      app.changed('structure');
      app.fit();
    },
    overlay(ctx, W, H) {
      if (!rect) return;
      const a = app.toScreen(rect.x, rect.y);
      const b = app.toScreen(rect.x + rect.w, rect.y + rect.h);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.fill('evenodd');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let k = 1; k < 3; k++) {
        const x = a.x + ((b.x - a.x) * k) / 3; const y = a.y + ((b.y - a.y) * k) / 3;
        ctx.moveTo(x, a.y); ctx.lineTo(x, b.y); ctx.moveTo(a.x, y); ctx.lineTo(b.x, y);
      }
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '12px system-ui';
      ctx.fillText(`${Math.round(rect.w)} × ${Math.round(rect.h)}`, a.x + 6, a.y + 16);
    },
  };
}

// ---------------------------------------------------------------- Brush, eraser, clone stamp, healing
// kind: 'brush' | 'eraser' | 'clone' | 'heal'
// While you paint, the stroke is collected on a separate canvas (doc.live) and shown
// live; when you let go it is "committed" into the layer (that's one undo step).
function cloneMask(c) {
  const m = makeCanvas(c.width, c.height);
  m.getContext('2d').drawImage(c, 0, 0);
  return m;
}

let busy = false; // an AI job is running

function makePaintTool(app, kind) {
  let last = null;
  let hoverPoint = null;

  function dab(ctx, x, y) {
    const o = app.opts;
    const live = app.doc.live;
    const r = Math.max(0.5, o.size / 2);
    const white = live.target === 'mask' || kind !== 'brush';
    const [cr, cg, cb] = white ? [255, 255, 255] : hexToRgb(o.color);
    if (o.hardness >= 0.99) {
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    } else {
      const g = ctx.createRadialGradient(x, y, r * o.hardness, x, y, r);
      g.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    const b = live.bbox;
    b.x0 = Math.min(b.x0, x - r); b.y0 = Math.min(b.y0, y - r);
    b.x1 = Math.max(b.x1, x + r); b.y1 = Math.max(b.y1, y + r);
  }

  // A copy of the pixels to copy from (all layers, or only the active one).
  function samplePixels(L) {
    if (!app.opts.sampleAll) return app.layerPixels(L);
    const c = makeCanvas(app.doc.width, app.doc.height);
    c.getContext('2d').drawImage(app.composite(), 0, 0);
    return c;
  }

  return {
    name: kind,
    cursor: 'none',
    down(p, e) {
      const doc = app.doc;
      const L = doc.active;
      const o = app.opts;

      if (kind === 'clone' && (e.altKey || o.pickSource)) {
        o.cloneSource = { x: p.x, y: p.y };
        o.cloneOffset = null;
        o.pickSource = false;
        app.toast('Source set. Now paint where you want to copy it.');
        app.refreshToolOptions();
        app.changed('overlay');
        return;
      }

      const onMask = doc.target === 'mask' && L && L.mask;
      if (onMask && (kind === 'clone' || kind === 'heal' || kind === 'airemove')) {
        app.toast('Clone and Heal work on the layer itself. Tap the layer thumbnail (not the mask) first.');
        return;
      }
      if (!L || (!onMask && L.type !== 'image')) {
        app.toast(L && L.type === 'text'
          ? 'This is a text layer. Add an empty layer (+ Layer) to paint, or use “Turn into pixels”.'
          : 'This tool works on image layers. Add an empty layer with “+ Layer”.');
        return;
      }
      if (kind === 'clone' && !o.cloneSource) {
        app.toast('First choose where to copy from: Alt + click, or tap “Set source” and then the picture.');
        return;
      }

      // copy the pixels to sample BEFORE the stroke starts
      if (busy) { app.toast('Please wait, the AI is still working…'); return; }
      const sample = kind === 'clone' || kind === 'heal' || kind === 'airemove' ? samplePixels(L) : null;

      let mode;
      if (onMask) mode = kind === 'eraser' ? 'reveal' : o.maskPaint;
      else mode = { brush: 'paint', eraser: 'erase', clone: 'clone', heal: 'heal', airemove: 'heal' }[kind];
      doc.live = {
        layerId: L.id,
        target: onMask ? 'mask' : 'layer',
        canvas: makeCanvas(doc.width, doc.height),
        mode,
        opacity: kind === 'heal' || kind === 'airemove' ? 1 : o.opacity,
        bbox: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      };

      if (kind === 'clone') {
        // offset = how far the source is from where you paint
        if (!o.cloneAligned || !o.cloneOffset) o.cloneOffset = { x: o.cloneSource.x - p.x, y: o.cloneSource.y - p.y };
        const fill = makeCanvas(doc.width, doc.height);
        fill.getContext('2d').drawImage(sample, -o.cloneOffset.x, -o.cloneOffset.y);
        sample.width = 0;
        doc.live.fill = fill;
      } else if (kind === 'heal' || kind === 'airemove') {
        doc.live.sample = sample;
      }

      last = p;
      dab(doc.live.canvas.getContext('2d'), p.x, p.y);
      app.changed('pixels');
    },
    move(p) {
      hoverPoint = p;
      const live = app.doc.live;
      if (!live || !last || busy) { app.changed('overlay'); return; }
      const ctx = live.canvas.getContext('2d');
      const step = Math.max(1, app.opts.size * 0.12);
      const d = dist(p, last);
      const n = Math.floor(d / step);
      for (let i = 1; i <= n; i++) {
        const t = (i * step) / d;
        dab(ctx, last.x + (p.x - last.x) * t, last.y + (p.y - last.y) * t);
      }
      if (n > 0) last = { x: last.x + (p.x - last.x) * (n * step) / d, y: last.y + (p.y - last.y) * (n * step) / d };
      app.changed('pixels');
    },
    hover(p) { hoverPoint = p; app.changed('overlay'); },
    up() {
      const doc = app.doc;
      const live = doc.live;
      last = null;
      if (!live || busy) return;
      const L = doc.layers.find((l) => l.id === live.layerId);

      if (kind === 'airemove') {
        // The AI takes a few seconds: keep the purple stroke visible meanwhile.
        const mask = cloneMask(app.renderer.liveStroke(doc));
        const b = live.bbox;
        const bbox = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
        busy = true;
        app.aiRemoveArea(L, live.sample, mask, bbox).finally(() => {
          busy = false;
          doc.live = null;
          freeCanvas(live.canvas); freeCanvas(live.sample); freeCanvas(mask);
          app.changed('commit');
        });
        return;
      }

      if (live.mode === 'heal') {
        const mask = app.renderer.liveStroke(doc); // limited to the selection
        const b = live.bbox;
        const bbox = { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 };
        const result = heal(live.sample, mask, bbox);
        doc.live = null;
        freeCanvas(live.canvas); freeCanvas(live.sample);
        if (result) {
          doc.checkpoint();
          doc.editCanvas(L, 'canvas', (ctx, c) => {
            ctx.setTransform(layerMatrix(L, c.width, c.height).inverse());
            ctx.drawImage(result.canvas, result.x, result.y);
          });
        }
        app.changed('commit');
        return;
      }

      const content = live.target === 'mask' ? app.renderer.liveStroke(doc) : app.renderer.liveContent(doc);
      doc.live = null;
      doc.checkpoint();
      if (live.target === 'mask') {
        doc.editCanvas(L, 'mask', (ctx) => {
          ctx.globalAlpha = live.opacity;
          ctx.globalCompositeOperation = live.mode === 'hide' ? 'destination-out' : 'source-over';
          ctx.drawImage(content, 0, 0);
        });
      } else {
        doc.editCanvas(L, 'canvas', (ctx, c) => {
          ctx.setTransform(layerMatrix(L, c.width, c.height).inverse());
          ctx.globalAlpha = live.opacity;
          ctx.globalCompositeOperation = live.mode === 'erase' ? 'destination-out' : 'source-over';
          ctx.drawImage(content, 0, 0);
        });
      }
      freeCanvas(live.canvas);
      freeCanvas(live.fill);
      app.changed('commit');
    },
    leave() { hoverPoint = null; app.changed('overlay'); },
    overlay(ctx) {
      const o = app.opts;
      if (kind === 'clone' && o.cloneSource) {
        // a small cross shows where the copy comes from
        const src = hoverPoint && o.cloneOffset && o.cloneAligned
          ? { x: hoverPoint.x + o.cloneOffset.x, y: hoverPoint.y + o.cloneOffset.y }
          : (app.doc.live && hoverPoint && o.cloneOffset ? { x: hoverPoint.x + o.cloneOffset.x, y: hoverPoint.y + o.cloneOffset.y } : o.cloneSource);
        const s = app.toScreen(src.x, src.y);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath(); ctx.moveTo(s.x - 9, s.y); ctx.lineTo(s.x + 9, s.y); ctx.moveTo(s.x, s.y - 9); ctx.lineTo(s.x, s.y + 9); ctx.stroke();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      if (!hoverPoint) return;
      const s = app.toScreen(hoverPoint.x, hoverPoint.y);
      const r = Math.max(2, (o.size / 2) * app.scale);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.beginPath(); ctx.arc(s.x, s.y, r + 1, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
    },
  };
}

// ---------------------------------------------------------------- Text
function makeTextTool(app, moveTool) {
  let moving = false;
  return {
    name: 'text',
    cursor: 'text',
    down(p, e) {
      const doc = app.doc;
      // Clicked on an existing text? Select it and let you drag it.
      for (let i = doc.layers.length - 1; i >= 0; i--) {
        const L = doc.layers[i];
        if (L.type === 'text' && L.visible && insidePolygon(p, layerCorners(L))) {
          doc.activeId = L.id;
          doc.target = 'layer';
          app.changed('structure');
          moveTool.start(p, e, L);
          moving = true;
          return;
        }
      }
      const L = baseLayer('text', 'Text');
      Object.assign(L, {
        text: 'Your text',
        font: FONTS[0][0],
        size: Math.max(12, Math.round(Math.min(doc.width, doc.height) / 10)),
        color: app.opts.color,
        bold: true,
        italic: false,
        align: 'center',
        lineHeight: 1.2,
        tf: { cx: p.x, cy: p.y, sx: 1, sy: 1, rot: 0 },
      });
      doc.checkpoint();
      doc.addLayer(L);
      app.changed('structure');
      app.focusText();
    },
    move(p, e) { if (moving) moveTool.move(p, e); },
    up() { if (moving) moveTool.up(); moving = false; },
    overlay(ctx) {
      const L = app.doc.active;
      if (L && L.type === 'text') moveTool.overlay(ctx);
    },
  };
}

// ---------------------------------------------------------------- Selections
function selectionMode(app, e) {
  if (e.shiftKey) return 'add';
  if (e.altKey) return 'subtract';
  return app.opts.selMode;
}

function applySelection(app, canvas, mode) {
  const doc = app.doc;
  doc.checkpoint();
  doc.setSelection(combine(doc.selection, canvas, mode));
  app.changed('selection');
}

function makeShapeSelectTool(app, type) {
  let drag = null;
  return {
    name: type === 'rect' ? 'marquee' : 'ellipse',
    cursor: 'crosshair',
    down(p, e) { drag = { p0: p, p, mode: selectionMode(app, e) }; },
    move(p) { if (drag) { drag.p = p; app.changed('overlay'); } },
    up() {
      if (!drag) return;
      const { p0, p, mode } = drag;
      drag = null;
      if (Math.abs(p.x - p0.x) < 2 || Math.abs(p.y - p0.y) < 2) {
        // a simple click removes the selection
        if (mode === 'new' && app.doc.selection) { app.doc.checkpoint(); app.doc.setSelection(null); app.changed('selection'); }
        app.changed('overlay');
        return;
      }
      const shape = { type, x: Math.min(p0.x, p.x), y: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y) };
      applySelection(app, shapeSelection(app.doc.width, app.doc.height, shape), mode);
    },
    overlay(ctx) {
      if (!drag) return;
      const a = app.toScreen(drag.p0.x, drag.p0.y);
      const b = app.toScreen(drag.p.x, drag.p.y);
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (type === 'rect') ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      else ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    },
  };
}

function makeLassoTool(app) {
  let pts = null;
  let mode = 'new';
  return {
    name: 'lasso',
    cursor: 'crosshair',
    down(p, e) { pts = [[p.x, p.y]]; mode = selectionMode(app, e); },
    move(p) {
      if (!pts) return;
      const [lx, ly] = pts[pts.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) * app.scale > 2) pts.push([p.x, p.y]);
      app.changed('overlay');
    },
    up() {
      if (!pts) return;
      const points = pts;
      pts = null;
      if (points.length < 3) { app.changed('overlay'); return; }
      applySelection(app, shapeSelection(app.doc.width, app.doc.height, { type: 'lasso', points }), mode);
    },
    overlay(ctx) {
      if (!pts) return;
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      pts.forEach(([x, y], i) => { const s = app.toScreen(x, y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
      ctx.stroke();
      ctx.setLineDash([]);
    },
  };
}

function makeWandTool(app) {
  return {
    name: 'wand',
    cursor: 'crosshair',
    down(p, e) {
      const o = app.opts;
      const source = o.wandAll ? app.composite() : app.layerPixels(app.doc.active);
      if (!source) { app.toast('Choose a layer with pixels, or tick “Use all layers”.'); return; }
      const sel = magicWand(source, p.x, p.y, o.tolerance, o.contiguous);
      if (sel) applySelection(app, sel, selectionMode(app, e));
    },
  };
}

// ---------------------------------------------------------------- AI Select
// Tap an object: the AI finds its outline. Shift/“+ Add” tap: include more. Alt/“− Subtract”: leave out.
function makeAiSelectTool(app) {
  let points = [];
  return {
    name: 'aiselect',
    cursor: 'crosshair',
    async down(p, e) {
      if (busy) { app.toast('Please wait, the AI is still working…'); return; }
      const mode = selectionMode(app, e);
      if (mode === 'new' || !points.length) points = [];
      points.push({ x: p.x, y: p.y, positive: mode !== 'subtract' });
      app.changed('overlay');
      busy = true;
      try {
        const sel = await app.aiSelect(points);
        if (sel) {
          app.doc.checkpoint();
          app.doc.setSelection(sel);
          app.changed('selection');
        }
      } catch (err) {
        console.error(err);
        app.toast(err.message || 'The AI could not run.');
        points = [];
      } finally {
        busy = false;
        app.changed('overlay');
      }
    },
    reset() { points = []; },
    overlay(ctx) {
      for (const pt of points) {
        const s = app.toScreen(pt.x, pt.y);
        ctx.fillStyle = pt.positive ? '#5be37d' : '#ff6b6b';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    },
  };
}

// ---------------------------------------------------------------- Hand (pan)
function makeHandTool(app) {
  let start = null;
  return {
    name: 'hand',
    cursor: 'grab',
    down(p, e) { start = { x: e.clientX, y: e.clientY, sl: app.scroller.scrollLeft, st: app.scroller.scrollTop }; },
    move(p, e) {
      if (!start) return;
      app.scroller.scrollLeft = start.sl - (e.clientX - start.x);
      app.scroller.scrollTop = start.st - (e.clientY - start.y);
    },
    up() { start = null; },
  };
}

export function makeTools(app) {
  const move = makeMoveTool(app);
  return {
    move,
    crop: makeCropTool(app),
    brush: makePaintTool(app, 'brush'),
    eraser: makePaintTool(app, 'eraser'),
    clone: makePaintTool(app, 'clone'),
    heal: makePaintTool(app, 'heal'),
    airemove: makePaintTool(app, 'airemove'),
    aiselect: makeAiSelectTool(app),
    text: makeTextTool(app, move),
    marquee: makeShapeSelectTool(app, 'rect'),
    ellipse: makeShapeSelectTool(app, 'ellipse'),
    lasso: makeLassoTool(app),
    wand: makeWandTool(app),
    hand: makeHandTool(app),
  };
}

export { layerSource };
