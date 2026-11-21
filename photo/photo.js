// photo.js — the photo editor page: connects the picture, the tools and the panels.

import { Doc, baseLayer, makeCanvas, cloneCanvas, freeCanvas, layerMatrix, MAX_SIDE } from './doc.js';
import { Renderer, layerThumb, maskThumb, textCanvas, layerSource } from './render.js';
import { ADJUSTMENTS } from './adjust.js';
import { makeTools, FONTS } from './tools.js';
import { selectAll, invertSelection, selectionOutline } from './selection.js';
import { curvesEditor } from './curves.js';
import { heal, opaqueBounds } from './heal.js';
import { makeTiff, makePdf, makePsd } from './formats.js';
import { aiSelect, findForeground, aiRemove } from './ai.js';

const $ = (id) => document.getElementById(id);
const view = $('view');
const overlay = $('overlay');
const scroller = $('scroller');
const workspace = $('workspace');

let doc = null;
const renderer = new Renderer();
let zoom = 1;

// Tool settings (shown in the bar above the picture)
const opts = {
  size: 40,
  hardness: 0.8,
  opacity: 1,
  color: '#ff3b6b',
  maskPaint: 'hide',
  selMode: 'new',
  tolerance: 32,
  contiguous: true,
  wandAll: true,
  sampleAll: true, // clone/heal copy from all layers
  cloneSource: null,
  cloneOffset: null,
  cloneAligned: true,
  pickSource: false,
};

// ---------------------------------------------------------------- the "app" object tools use
const app = {
  get doc() { return doc; },
  renderer,
  opts,
  scroller,
  get scale() { return view.getBoundingClientRect().width / doc.width; },
  toDoc(e) {
    const r = view.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * doc.width, y: ((e.clientY - r.top) / r.height) * doc.height };
  },
  toScreen(x, y) {
    const r = view.getBoundingClientRect();
    const w = workspace.getBoundingClientRect();
    return { x: r.left - w.left + (x * r.width) / doc.width, y: r.top - w.top + (y * r.height) / doc.height };
  },
  changed,
  toast,
  refreshToolOptions: () => renderToolOptions(),
  aiSelect: (points) => runAi(() => aiSelect(snapshotPicture(), pictureKey(), points, status)),
  aiRemoveArea: (L, sample, mask, bbox) => runAi(async () => {
    const result = await aiRemove(sample, mask, bbox, status);
    applyPatch(L, result);
  }),
  fit,
  composite: () => renderer.render(doc, { useCache: false }),
  layerPixels(L) {
    if (!L || L.type === 'adjust') return null;
    const c = makeCanvas(doc.width, doc.height);
    const src = layerSource(L);
    const ctx = c.getContext('2d');
    ctx.setTransform(layerMatrix(L, src.width, src.height));
    ctx.drawImage(src, 0, 0);
    return c;
  },
  focusText() {
    requestAnimationFrame(() => {
      const t = document.querySelector('#props textarea');
      if (t) { t.focus(); t.select(); }
    });
  },
};

// ---------------------------------------------------------------- AI helpers
// A copy of what you see (all layers), and a "fingerprint" that changes when it changes.
function snapshotPicture() {
  const c = makeCanvas(doc.width, doc.height);
  c.getContext('2d').drawImage(renderer.render(doc, { useCache: false }), 0, 0);
  return c;
}
function pictureKey() {
  return `${doc.width}x${doc.height}|` + doc.layers.map((l) => `${l.id}:${l.rev}:${l.visible ? 1 : 0}`).join(',');
}
// A message that stays while the AI works.
function status(msg) { toast(msg, 0); }

async function runAi(job) {
  try {
    const r = await job();
    hideToast();
    return r;
  } catch (err) {
    console.error(err);
    toast(err.message || 'The AI could not run on this device.');
    return null;
  }
}

// Put new pixels (in picture coordinates) into an image layer.
function applyPatch(L, result) {
  if (!result) return;
  doc.checkpoint();
  doc.editCanvas(L, 'canvas', (ctx, c) => {
    ctx.setTransform(layerMatrix(L, c.width, c.height).inverse());
    ctx.drawImage(result.canvas, result.x, result.y);
  });
  changed('commit');
}

async function removeBackground(L) {
  if (!L || L.type !== 'image') { toast('Choose a photo layer first.'); return; }
  const pixels = app.layerPixels(L);
  const fg = await runAi(() => findForeground(pixels, status));
  freeCanvas(pixels);
  if (!fg) return;
  doc.checkpoint();
  if (L.mask) {
    // keep what the old mask already hid
    const m = cloneCanvas(L.mask);
    const mctx = m.getContext('2d');
    mctx.globalCompositeOperation = 'destination-in';
    mctx.drawImage(fg, 0, 0);
    L.mask = m;
  } else {
    L.mask = fg;
  }
  doc.touch(L);
  doc.target = 'mask';
  changed('structure');
  toast('Background hidden with a mask. Paint the mask (Hide / Reveal) to fix details.');
}

async function selectSubject() {
  const fg = await runAi(() => findForeground(snapshotPicture(), status));
  if (!fg) return;
  doc.checkpoint();
  doc.setSelection(fg);
  changed('selection');
}

async function aiRemoveSelection() {
  const L = doc.active;
  if (!doc.selection) return;
  if (!L || L.type !== 'image') { toast('Choose an image layer first (or add an empty layer).'); return; }
  const bbox = opaqueBounds(doc.selection);
  if (!bbox) return;
  const sample = opts.sampleAll ? snapshotPicture() : app.layerPixels(L);
  await runAi(async () => applyPatch(L, await aiRemove(sample, doc.selection, bbox, status)));
  freeCanvas(sample);
}

const tools = makeTools(app);
let tool = tools.move;
let toolName = 'move';

// ---------------------------------------------------------------- redraw scheduling
let need = { render: false, overlay: false, layers: false, props: false };
let frameQueued = false;

function changed(kind = 'pixels') {
  if (!doc) return;
  if (kind === 'pixels' || kind === 'commit' || kind === 'structure') need.render = true;
  if (kind === 'commit' || kind === 'structure') need.layers = true;
  if (kind === 'structure') need.props = true;
  if (kind === 'commit') need.propsValues = true;
  if (kind === 'selection') need.toolOptions = true;
  need.overlay = true;
  if (!frameQueued) { frameQueued = true; requestAnimationFrame(frame); }
}

function frame() {
  frameQueued = false;
  if (!doc) return;
  const n = need;
  need = {};
  if (n.render) {
    if (view.width !== doc.width || view.height !== doc.height) {
      view.width = doc.width;
      view.height = doc.height;
      fit(); // the picture changed size (new, crop, undo): show all of it
    }
    const out = renderer.render(doc, { useCache: true });
    const vctx = view.getContext('2d');
    vctx.globalCompositeOperation = 'copy';
    vctx.drawImage(out, 0, 0);
    vctx.globalCompositeOperation = 'source-over';
  }
  if (n.layers) renderLayers();
  if (n.props) renderProps();
  else if (n.propsValues && !$('props').contains(document.activeElement)) renderProps();
  if (n.toolOptions) renderToolOptions();
  drawOverlay();
  $('btn-undo').disabled = !doc.undoStack.length;
  $('btn-redo').disabled = !doc.redoStack.length;
  $('doc-size').textContent = `${doc.width} × ${doc.height}px`;
}

// ---------------------------------------------------------------- overlay (handles, selection outline…)
let outlineCache = { key: '', canvas: null };

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const W = workspace.clientWidth;
  const H = workspace.clientHeight;
  if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
    overlay.width = Math.round(W * dpr);
    overlay.height = Math.round(H * dpr);
  }
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!doc) return;

  if (doc.selection) {
    const r = view.getBoundingClientRect();
    const w = workspace.getBoundingClientRect();
    const ow = Math.min(2048, r.width);
    const oh = Math.min(2048 * (r.height / r.width), r.height);
    const key = `${doc.selectionRev}|${Math.round(ow)}x${Math.round(oh)}`;
    if (outlineCache.key !== key) {
      freeCanvas(outlineCache.canvas);
      outlineCache = { key, canvas: selectionOutline(doc.selection, ow, oh) };
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(outlineCache.canvas, r.left - w.left, r.top - w.top, r.width, r.height);
    ctx.imageSmoothingEnabled = true;
  }
  if (tool.overlay) tool.overlay(ctx, W, H);
}

// ---------------------------------------------------------------- zoom & scrolling
function applyZoom() {
  if (!doc) return;
  view.style.width = `${doc.width * zoom}px`;
  view.style.height = `${doc.height * zoom}px`;
  view.classList.toggle('pixelated', zoom >= 2);
  $('zoom-fit').textContent = `${Math.round(zoom * 100)}%`;
  changed('overlay');
}

function fit() {
  if (!doc) return;
  const W = workspace.clientWidth - 64;
  const H = workspace.clientHeight - 64;
  zoom = Math.max(0.02, Math.min(W / doc.width, H / doc.height, 4));
  applyZoom();
}

// Zoom while keeping the point under (clientX, clientY) in place.
function zoomAt(newZoom, clientX, clientY) {
  newZoom = Math.min(32, Math.max(0.02, newZoom));
  const r = view.getBoundingClientRect();
  const fx = (clientX - r.left) / r.width;
  const fy = (clientY - r.top) / r.height;
  zoom = newZoom;
  applyZoom();
  const r2 = view.getBoundingClientRect();
  scroller.scrollLeft += r2.left + fx * r2.width - clientX;
  scroller.scrollTop += r2.top + fy * r2.height - clientY;
}

function zoomCenter(f) {
  const w = workspace.getBoundingClientRect();
  zoomAt(zoom * f, w.left + w.width / 2, w.top + w.height / 2);
}

$('zoom-in').onclick = () => zoomCenter(1.25);
$('zoom-out').onclick = () => zoomCenter(0.8);
$('zoom-fit').onclick = fit;
scroller.addEventListener('scroll', () => changed('overlay'));
new ResizeObserver(() => changed('overlay')).observe(workspace);

scroller.addEventListener('wheel', (e) => {
  if (!doc || !(e.ctrlKey || e.metaKey)) return; // trackpad pinch sends ctrl+wheel
  e.preventDefault();
  zoomAt(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
}, { passive: false });

// ---------------------------------------------------------------- pointer input
const pointers = new Map();
let pinch = null;
let spaceHand = false;
let pressing = false;

function currentTool() { return spaceHand ? tools.hand : tool; }

scroller.addEventListener('pointerdown', (e) => {
  if (!doc) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  scroller.setPointerCapture(e.pointerId);
  if (pointers.size === 2) {
    // Two fingers: stop what the tool was doing and zoom/pan instead.
    if (pressing) cancelPress();
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, zoom };
    return;
  }
  if (pointers.size > 2 || e.button > 0) return;
  pressing = true;
  currentTool().down?.(app.toDoc(e), e);
});

scroller.addEventListener('pointermove', (e) => {
  if (!doc) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    zoomAt(pinch.zoom * (d / pinch.d), mx, my);
    scroller.scrollLeft -= mx - pinch.mx;
    scroller.scrollTop -= my - pinch.my;
    pinch.mx = mx; pinch.my = my;
    return;
  }
  const p = app.toDoc(e);
  if (pressing) currentTool().move?.(p, e);
  else if (e.pointerType !== 'touch') currentTool().hover?.(p, e);
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  if (!pressing) return;
  pressing = false;
  currentTool().up?.(app.toDoc(e), e);
}
scroller.addEventListener('pointerup', endPointer);
scroller.addEventListener('pointercancel', endPointer);
scroller.addEventListener('pointerleave', () => tool.leave?.());

function cancelPress() {
  pressing = false;
  if (doc.live) { freeCanvas(doc.live.canvas); doc.live = null; changed('pixels'); }
  currentTool().up?.({ x: 0, y: 0 }, {});
}

// ---------------------------------------------------------------- tools
const toolHints = {
  move: 'Drag to move the layer. Drag a corner to resize, the round handle to rotate (Shift: 15° steps).',
  crop: 'Drag to choose the part to keep.',
  text: 'Tap the picture to add text, or tap a text to select and drag it. Edit it on the right.',
  hand: 'Drag to move around. Pinch or Ctrl + scroll to zoom.',
  aiselect: 'Tap an object: the AI selects it. “+ Add” (or Shift) tap to include more, “− Subtract” (or Alt) to leave a part out.',
  airemove: 'Paint over something to remove: the AI fills it with background when you let go.',
  clone: 'Alt + click (or “Set source”) where to copy from, then paint. Tip: paint on an empty layer to keep the photo intact.',
  heal: 'Paint over a spot or a small object: when you let go, it is replaced by texture from around it.',
};

function setTool(name) {
  if (!tools[name] || !doc) return;
  if (tool.deactivate) tool.deactivate();
  tool = tools[name];
  toolName = name;
  if (tool.activate) tool.activate();
  for (const b of $('toolbar').children) b.classList.toggle('active', b.dataset.tool === name);
  scroller.style.cursor = tool.cursor || 'default';
  renderToolOptions();
  changed('overlay');
}
$('toolbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

// Small helpers to build controls
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n[k] = v;
    else if (k in n && typeof v !== 'string') n[k] = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
}

function rangeOpt(label, min, max, step, get, set, fmt = (v) => v) {
  const out = el('output', {}, fmt(get()));
  const input = el('input', { type: 'range', min, max, step, value: get() });
  input.oninput = () => { set(Number(input.value)); out.textContent = fmt(Number(input.value)); changed('overlay'); };
  return el('label', { class: 'opt' }, [el('span', { class: 'muted' }, label), input, out]);
}

function chipGroup(options, get, set) {
  const wrap = el('div', { class: 'chips' });
  for (const [value, label] of options) {
    const b = el('button', { class: `chip${get() === value ? ' active' : ''}` }, label);
    b.onclick = () => { set(value); for (const c of wrap.children) c.classList.toggle('active', c === b); };
    wrap.append(b);
  }
  return wrap;
}

function renderToolOptions() {
  const box = $('tool-options');
  box.replaceChildren();
  if (!doc) return;
  const add = (...n) => box.append(...n);
  const sep = () => el('span', { class: 'sep' });

  if (toolName === 'aiselect') {
    add(chipGroup([['new', 'New'], ['add', '+ Add'], ['subtract', '− Subtract']], () => opts.selMode, (v) => (opts.selMode = v)));
    add(el('button', { class: 'btn small', onclick: () => selectSubject(), title: 'Select the person / main subject automatically' }, '👤 Select subject'));
    add(sep(), ...selectionButtons());
    add(el('span', { class: 'hint' }, toolHints.aiselect));
  } else if (toolName === 'airemove') {
    add(rangeOpt('Size', 4, 400, 1, () => opts.size, (v) => (opts.size = v), (v) => `${v}px`));
    const all = el('input', { type: 'checkbox', checked: opts.sampleAll });
    all.onchange = () => (opts.sampleAll = all.checked);
    add(el('label', { class: 'opt' }, [all, 'Use all layers']));
    add(el('span', { class: 'hint' }, toolHints.airemove));
  } else if (toolName === 'clone' || toolName === 'heal') {
    add(rangeOpt('Size', 1, 400, 1, () => opts.size, (v) => (opts.size = v), (v) => `${v}px`));
    add(rangeOpt('Hardness', 0, 100, 1, () => Math.round(opts.hardness * 100), (v) => (opts.hardness = v / 100), (v) => `${v}%`));
    if (toolName === 'clone') {
      add(rangeOpt('Opacity', 1, 100, 1, () => Math.round(opts.opacity * 100), (v) => (opts.opacity = v / 100), (v) => `${v}%`));
      const pick = el('button', { class: `btn small toggle-btn${opts.pickSource ? ' active' : ''}`, title: 'Then tap the picture where you want to copy from (or Alt + click)' }, '◎ Set source');
      pick.onclick = () => { opts.pickSource = !opts.pickSource; pick.classList.toggle('active', opts.pickSource); };
      const aligned = el('input', { type: 'checkbox', checked: opts.cloneAligned });
      aligned.onchange = () => { opts.cloneAligned = aligned.checked; opts.cloneOffset = null; };
      add(sep(), pick, el('label', { class: 'opt', title: 'Keep the same distance between source and brush for every stroke' }, [aligned, 'Aligned']));
    }
    const all = el('input', { type: 'checkbox', checked: opts.sampleAll });
    all.onchange = () => (opts.sampleAll = all.checked);
    add(el('label', { class: 'opt', title: 'Copy from what you see (all layers). Untick to copy only from this layer.' }, [all, 'Use all layers']));
    add(el('span', { class: 'hint' }, toolHints[toolName]));
  } else if (toolName === 'brush' || toolName === 'eraser') {
    add(rangeOpt('Size', 1, 400, 1, () => opts.size, (v) => (opts.size = v), (v) => `${v}px`));
    add(rangeOpt('Hardness', 0, 100, 1, () => Math.round(opts.hardness * 100), (v) => (opts.hardness = v / 100), (v) => `${v}%`));
    add(rangeOpt('Opacity', 1, 100, 1, () => Math.round(opts.opacity * 100), (v) => (opts.opacity = v / 100), (v) => `${v}%`));
    if (toolName === 'brush') {
      if (doc.target === 'mask') {
        add(sep(), chipGroup([['hide', '⬛ Hide'], ['reveal', '⬜ Reveal']], () => opts.maskPaint, (v) => (opts.maskPaint = v)));
      } else {
        const color = el('input', { type: 'color', value: opts.color, title: 'Brush color' });
        color.oninput = () => (opts.color = color.value);
        add(el('label', { class: 'opt' }, [el('span', { class: 'muted' }, 'Color'), color]));
      }
    }
    add(el('span', { class: 'hint' }, doc.target === 'mask' ? 'Painting on the mask.' : ''));
  } else if (['marquee', 'ellipse', 'lasso', 'wand'].includes(toolName)) {
    add(chipGroup([['new', 'New'], ['add', '+ Add'], ['subtract', '− Subtract']], () => opts.selMode, (v) => (opts.selMode = v)));
    if (toolName === 'wand') {
      add(rangeOpt('Tolerance', 0, 128, 1, () => opts.tolerance, (v) => (opts.tolerance = v)));
      const cont = el('input', { type: 'checkbox', checked: opts.contiguous });
      cont.onchange = () => (opts.contiguous = cont.checked);
      const all = el('input', { type: 'checkbox', checked: opts.wandAll });
      all.onchange = () => (opts.wandAll = all.checked);
      add(el('label', { class: 'opt' }, [cont, 'Connected only']), el('label', { class: 'opt' }, [all, 'Use all layers']));
    }
    add(sep(), ...selectionButtons());
  } else if (toolName === 'crop') {
    add(el('span', { class: 'hint' }, toolHints.crop));
    add(el('button', { class: 'btn small primary', onclick: () => tools.crop.apply() }, '✓ Apply crop'));
    add(el('button', { class: 'btn small ghost', onclick: () => { tools.crop.activate(); changed('overlay'); } }, 'Reset'));
  } else if (toolName === 'text') {
    add(el('span', { class: 'hint' }, toolHints.text));
    const color = el('input', { type: 'color', value: opts.color, title: 'Color for new text' });
    color.oninput = () => (opts.color = color.value);
    add(el('label', { class: 'opt' }, [el('span', { class: 'muted' }, 'Color'), color]));
  } else {
    add(el('span', { class: 'hint' }, toolHints[toolName] || ''));
    if (toolName === 'move' && doc.selection) add(sep(), ...selectionButtons());
  }
}

function selectionButtons() {
  const b = (label, fn, title = '') => el('button', { class: 'btn small', onclick: fn, title }, label);
  const list = [
    b('All', () => selection('all'), 'Select all (Ctrl+A)'),
  ];
  if (doc.selection) {
    list.push(
      b('None', () => selection('none'), 'Deselect (Ctrl+D)'),
      b('Invert', () => selection('invert'), 'Invert (Ctrl+Shift+I)'),
      b('Fill', () => selection('fill'), 'Fill with the brush color'),
      b('Delete', () => selection('delete'), 'Erase the selected pixels (Delete)'),
      b('✨ Heal', () => selection('heal'), 'Fill the selection with texture from around it (remove an object)'),
      b('🤖 AI Remove', () => aiRemoveSelection(), 'Remove what is selected with AI (best for objects and people)'),
      b('→ Mask', () => selection('mask'), 'Make a layer mask from the selection'),
    );
  }
  return list;
}

function selection(action) {
  if (!doc) return;
  const L = doc.active;
  if (action === 'all') { doc.checkpoint(); doc.setSelection(selectAll(doc.width, doc.height)); }
  else if (action === 'none') { if (!doc.selection) return; doc.checkpoint(); doc.setSelection(null); }
  else if (action === 'invert') { doc.checkpoint(); doc.setSelection(invertSelection(doc.selection, doc.width, doc.height)); }
  else if (action === 'heal') {
    if (!doc.selection) return;
    if (!L || L.type !== 'image') { toast('Choose an image layer first (or add an empty layer).'); return; }
    const bbox = opaqueBounds(doc.selection);
    if (!bbox) return;
    if (bbox.w * bbox.h > 1600 * 1600) { toast('This selection is too big to heal. Try a smaller area.'); return; }
    toast('Healing…');
    setTimeout(() => {
      let sample;
      if (opts.sampleAll) {
        sample = makeCanvas(doc.width, doc.height);
        sample.getContext('2d').drawImage(app.composite(), 0, 0);
      } else sample = app.layerPixels(L);
      const result = heal(sample, doc.selection, bbox);
      freeCanvas(sample);
      if (!result) return;
      doc.checkpoint();
      doc.editCanvas(L, 'canvas', (ctx, c) => {
        ctx.setTransform(layerMatrix(L, c.width, c.height).inverse());
        ctx.drawImage(result.canvas, result.x, result.y);
      });
      toast('Done.');
      changed('commit');
    }, 30);
    return;
  }
  else if (action === 'delete' || action === 'fill') {
    if (!doc.selection) return;
    if (!L || L.type !== 'image') { toast('Choose an image layer first.'); return; }
    doc.checkpoint();
    const sel = doc.selection;
    doc.editCanvas(L, 'canvas', (ctx, c) => {
      ctx.setTransform(layerMatrix(L, c.width, c.height).inverse());
      if (action === 'delete') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(sel, 0, 0);
      } else {
        const fill = makeCanvas(doc.width, doc.height);
        const fctx = fill.getContext('2d');
        fctx.drawImage(sel, 0, 0);
        fctx.globalCompositeOperation = 'source-in';
        fctx.fillStyle = opts.color;
        fctx.fillRect(0, 0, doc.width, doc.height);
        ctx.drawImage(fill, 0, 0);
      }
    });
    changed('commit');
  } else if (action === 'mask') {
    if (!L || !doc.selection) return;
    doc.checkpoint();
    L.mask = cloneCanvas(doc.selection);
    doc.touch(L);
    doc.setSelection(null);
    doc.target = 'mask';
    changed('structure');
  }
  changed('selection');
}

// ---------------------------------------------------------------- layers panel
const BLEND_NAMES = Object.fromEntries([...$('blend').options].map((o) => [o.value, o.text]));

for (const [key, def] of Object.entries(ADJUSTMENTS)) $('adjust-add').append(el('option', { value: key }, def.label));

function renderLayers() {
  const list = $('layers');
  list.replaceChildren();
  if (!doc) return;
  const L = doc.active;
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const layer = doc.layers[i];
    const li = el('li', {
      class: `layer${layer === L ? ' active' : ''}${layer.visible ? '' : ' hidden-layer'}${layer.clip && i > 0 ? ' clipped' : ''}`,
      title: `${layer.name}${layer.blend !== 'source-over' ? ` · ${BLEND_NAMES[layer.blend]}` : ''}${layer.opacity < 1 ? ` · ${Math.round(layer.opacity * 100)}%` : ''}`,
    });
    const eye = el('button', { class: 'eye', title: layer.visible ? 'Hide' : 'Show' }, layer.visible ? '👁' : '◌');
    eye.onclick = (e) => {
      e.stopPropagation();
      doc.checkpoint();
      layer.visible = !layer.visible;
      changed('commit');
    };
    let thumb;
    if (layer.type === 'adjust') {
      thumb = el('div', { class: 'thumb icon' }, '◐');
    } else {
      thumb = el('div', { class: `thumb${layer === L && doc.target === 'layer' && layer.mask ? ' editing' : ''}` }, layerThumb(layer, doc));
    }
    thumb.onclick = (e) => { e.stopPropagation(); selectLayer(layer, 'layer'); };
    li.append(eye, thumb);
    if (layer.mask) {
      const mt = el('div', { class: `thumb mask${layer === L && doc.target === 'mask' ? ' editing' : ''}`, title: 'Layer mask: tap to paint on it' }, maskThumb(layer, doc));
      mt.onclick = (e) => { e.stopPropagation(); selectLayer(layer, 'mask'); };
      li.append(mt);
    }
    const name = el('span', { class: 'name' }, `${layer.clip && i > 0 ? '↳ ' : ''}${layer.name}`);
    name.ondblclick = (e) => { e.stopPropagation(); renameLayer(layer, name); };
    li.append(name);
    li.onclick = () => selectLayer(layer, doc.activeId === layer.id ? doc.target : 'layer');
    li.ondblclick = () => renameLayer(layer, name);
    list.append(li);
  }

  // controls for the active layer
  $('blend').value = L ? L.blend : 'source-over';
  $('opacity').value = L ? Math.round(L.opacity * 100) : 100;
  $('opacity-value').textContent = `${$('opacity').value}%`;
  $('blend').disabled = $('opacity').disabled = !L;
  for (const id of ['layer-mask', 'layer-clip', 'layer-dup', 'layer-up', 'layer-down', 'layer-del']) $(id).disabled = !L;
  $('layer-mask').textContent = L && L.mask ? 'Remove mask' : 'Mask';
  $('layer-clip').classList.toggle('active', !!(L && L.clip));
}

function selectLayer(layer, target = 'layer') {
  const changedLayer = doc.activeId !== layer.id;
  doc.activeId = layer.id;
  doc.target = layer.mask ? target : 'layer';
  changed('structure');
  if (changedLayer || ['brush', 'eraser'].includes(toolName)) renderToolOptions();
}

function renameLayer(layer, nameEl) {
  const input = el('input', { type: 'text', value: layer.name });
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  const done = () => {
    const v = input.value.trim();
    if (v && v !== layer.name) { doc.checkpoint(); layer.name = v; }
    changed('commit');
  };
  input.onblur = done;
  input.onkeydown = (e) => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = layer.name; input.blur(); } };
  input.onclick = (e) => e.stopPropagation();
}

// opacity slider + blend mode
let sliderUndo = false;
function startDrag() { if (!sliderUndo) { doc.checkpoint(); sliderUndo = true; } }
function endDrag() { sliderUndo = false; changed('commit'); }

$('opacity').oninput = () => {
  const L = doc.active;
  if (!L) return;
  startDrag();
  L.opacity = Number($('opacity').value) / 100;
  $('opacity-value').textContent = `${$('opacity').value}%`;
  doc.touch(L);
  changed('pixels');
};
$('opacity').onchange = endDrag;
$('blend').onchange = () => {
  const L = doc.active;
  if (!L) return;
  doc.checkpoint();
  L.blend = $('blend').value;
  doc.touch(L);
  changed('commit');
};

$('layer-add').onclick = () => {
  doc.checkpoint();
  const L = doc.newImageLayer(makeCanvas(doc.width, doc.height), `Layer ${doc.layers.length + 1}`);
  doc.addLayer(L);
  changed('structure');
};

$('adjust-add').onchange = () => {
  const kind = $('adjust-add').value;
  $('adjust-add').value = '';
  if (!kind) return;
  doc.checkpoint();
  const L = baseLayer('adjust', ADJUSTMENTS[kind].label);
  L.kind = kind;
  L.params = structuredClone(ADJUSTMENTS[kind].params);
  if (doc.selection) L.mask = cloneCanvas(doc.selection); // only change the selected area
  doc.addLayer(L);
  changed('structure');
};

$('layer-mask').onclick = () => {
  const L = doc.active;
  if (!L) return;
  doc.checkpoint();
  if (L.mask) {
    L.mask = null;
    doc.target = 'layer';
  } else {
    L.mask = doc.selection ? cloneCanvas(doc.selection) : selectAll(doc.width, doc.height);
    doc.target = 'mask';
    if (!doc.selection) toast('Mask added. Paint on it with the brush: Hide or Reveal parts of the layer.');
  }
  doc.touch(L);
  changed('structure');
  renderToolOptions();
};

$('layer-clip').onclick = () => {
  const L = doc.active;
  if (!L) return;
  if (doc.activeIndex === 0) { toast('Clipping needs a layer below this one.'); return; }
  doc.checkpoint();
  L.clip = !L.clip;
  doc.touch(L);
  changed('structure');
};

$('layer-dup').onclick = () => {
  const L = doc.active;
  if (!L) return;
  doc.checkpoint();
  const copy = { ...L, ...baseLayer(L.type, `${L.name} copy`) };
  for (const k of ['visible', 'opacity', 'blend', 'clip', 'mask']) copy[k] = L[k];
  if (L.tf) copy.tf = { ...L.tf };
  if (L.params) copy.params = structuredClone(L.params);
  doc.addLayer(copy, { above: L });
  changed('structure');
};

$('layer-up').onclick = () => { const L = doc.active; if (!L) return; doc.checkpoint(); if (doc.moveLayer(L, 1)) changed('structure'); else doc.undoStack.pop(); };
$('layer-down').onclick = () => { const L = doc.active; if (!L) return; doc.checkpoint(); if (doc.moveLayer(L, -1)) changed('structure'); else doc.undoStack.pop(); };
$('layer-del').onclick = () => {
  const L = doc.active;
  if (!L) return;
  doc.checkpoint();
  doc.removeLayer(L);
  changed('structure');
};

// ---------------------------------------------------------------- properties panel
function propSlider(label, min, max, step, get, set, fmt = (v) => v) {
  const out = el('span', {}, fmt(get()));
  const input = el('input', { type: 'range', min, max, step, value: get() });
  input.oninput = () => {
    startDrag();
    set(Number(input.value));
    out.textContent = fmt(Number(input.value));
    doc.touch(doc.active);
    changed('pixels');
  };
  input.onchange = endDrag;
  return el('label', { class: 'prop' }, [el('span', { class: 'prop-head' }, [label, out]), input]);
}

function numberField(label, get, set) {
  const input = el('input', { type: 'number', value: get(), step: 'any' });
  input.onchange = () => {
    const v = Number(input.value);
    if (!Number.isFinite(v)) return;
    doc.checkpoint();
    set(v);
    doc.touch(doc.active);
    changed('commit');
  };
  return el('label', { class: 'prop' }, [el('span', { class: 'prop-head' }, label), input]);
}

function transformProps(L) {
  const r = (v) => Math.round(v * 10) / 10;
  const box = el('div', {}, [
    el('div', { class: 'grid2' }, [
      numberField('X', () => r(L.tf.cx), (v) => (L.tf.cx = v)),
      numberField('Y', () => r(L.tf.cy), (v) => (L.tf.cy = v)),
      numberField('Scale %', () => r(Math.abs(L.tf.sx) * 100), (v) => {
        const f = Math.max(0.1, v) / 100;
        L.tf.sx = Math.sign(L.tf.sx) * f;
        L.tf.sy = Math.sign(L.tf.sy) * f;
      }),
      numberField('Rotation °', () => r(L.tf.rot), (v) => (L.tf.rot = v)),
    ]),
    el('div', { class: 'prop-row', style: 'margin-top:8px' }, [
      el('button', { class: 'btn small', onclick: () => editTf(L, () => (L.tf.sx *= -1)) }, '⇋ Flip'),
      el('button', { class: 'btn small', onclick: () => editTf(L, () => (L.tf.sy *= -1)) }, '⇵ Flip'),
      el('button', { class: 'btn small', onclick: () => editTf(L, () => (L.tf.rot = (L.tf.rot + 90 + 180) % 360 - 180)) }, '↻ 90°'),
      el('button', { class: 'btn small ghost', onclick: () => editTf(L, () => Object.assign(L.tf, { sx: 1, sy: 1, rot: 0, cx: doc.width / 2, cy: doc.height / 2 })) }, 'Reset'),
    ]),
  ]);
  return box;
}

function editTf(L, fn) {
  doc.checkpoint();
  fn();
  doc.touch(L);
  changed('commit');
  renderProps();
}

function textProps(L) {
  const ta = el('textarea', {}, L.text);
  ta.value = L.text;
  ta.onfocus = () => { doc.checkpoint(); };
  ta.oninput = () => { L.text = ta.value; doc.touch(L); changed('pixels'); };
  ta.onblur = () => changed('commit');

  const font = el('select', {});
  for (const [value, label] of FONTS) font.append(el('option', { value }, label));
  font.value = L.font;
  font.onchange = () => setText(L, { font: font.value });

  const color = el('input', { type: 'color', value: L.color, title: 'Text color' });
  color.onfocus = () => doc.checkpoint();
  color.oninput = () => { L.color = color.value; doc.touch(L); changed('pixels'); };
  color.onchange = () => changed('commit');

  const toggle = (label, key) => {
    const b = el('button', { class: `btn small toggle-btn${L[key] ? ' active' : ''}` }, label);
    b.onclick = () => { setText(L, { [key]: !L[key] }); b.classList.toggle('active', L[key]); };
    return b;
  };
  const align = chipGroup([['left', '⟸'], ['center', '≡'], ['right', '⟹']], () => L.align, (v) => setText(L, { align: v }));

  return el('div', {}, [
    el('label', { class: 'prop' }, [el('span', { class: 'prop-head' }, 'Text'), ta]),
    el('label', { class: 'prop' }, [el('span', { class: 'prop-head' }, 'Font'), font]),
    el('div', { class: 'prop-row' }, [color, toggle('B', 'bold'), toggle('I', 'italic'), align]),
    propSlider('Size', 6, 600, 1, () => L.size, (v) => (L.size = v), (v) => `${v}px`),
    propSlider('Line spacing', 0.8, 3, 0.05, () => L.lineHeight, (v) => (L.lineHeight = v)),
  ]);
}

function setText(L, change) {
  doc.checkpoint();
  Object.assign(L, change);
  doc.touch(L);
  changed('commit');
}

const RANGE_NAMES = [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']];
let balanceRange = 'midtones';

function colorBalanceProps(L) {
  const box = el('div');
  const draw = () => {
    box.replaceChildren(
      chipGroup(RANGE_NAMES, () => balanceRange, (v) => { balanceRange = v; draw(); }),
      el('div', { style: 'height:8px' }),
      ...[['Cyan ↔ Red', 0], ['Magenta ↔ Green', 1], ['Yellow ↔ Blue', 2]].map(([label, k]) =>
        propSlider(label, -100, 100, 1, () => L.params[balanceRange][k], (v) => (L.params[balanceRange][k] = v))),
    );
    const keep = el('input', { type: 'checkbox', checked: L.params.preserve });
    keep.onchange = () => { doc.checkpoint(); L.params.preserve = keep.checked; doc.touch(L); changed('commit'); };
    box.append(el('label', { class: 'opt prop' }, [keep, ' Keep brightness']));
  };
  draw();
  return box;
}

function renderProps() {
  const box = $('props');
  box.replaceChildren();
  const L = doc && doc.active;
  if (!L) { $('props-title').textContent = 'Properties'; return; }

  if (doc.target === 'mask' && L.mask) {
    $('props-title').textContent = `${L.name} · mask`;
    box.append(
      el('p', { class: 'prop-note' }, 'White parts of the mask show the layer, black parts hide it. Paint with the Brush: “Hide” paints black, “Reveal” paints white. The Eraser reveals.'),
      el('div', { class: 'prop-row' }, [
        el('button', { class: 'btn small', onclick: () => { setTool('brush'); } }, '🖌 Paint the mask'),
        el('button', { class: 'btn small', onclick: () => {
          doc.checkpoint();
          L.mask = invertSelection(L.mask, doc.width, doc.height);
          doc.touch(L);
          changed('structure');
        } }, 'Invert mask'),
        el('button', { class: 'btn small ghost', onclick: () => selectLayer(L, 'layer') }, 'Back to layer'),
      ]),
    );
    return;
  }

  if (L.type === 'adjust') {
    const def = ADJUSTMENTS[L.kind];
    $('props-title').textContent = def.label;
    if (def.custom === 'curves') {
      box.append(curvesEditor(L.params, () => { doc.touch(L); changed('pixels'); }, () => doc.checkpoint()));
    } else if (def.custom === 'colorBalance') {
      box.append(colorBalanceProps(L));
    } else {
      for (const [key, label, min, max, step = 1] of def.sliders) {
        box.append(propSlider(label, min, max, step, () => L.params[key], (v) => (L.params[key] = v)));
      }
      if (!def.sliders.length) box.append(el('p', { class: 'prop-note' }, 'No settings: hide or delete the layer to undo it.'));
    }
    box.append(el('div', { class: 'prop-row' }, [
      el('button', { class: 'btn small ghost', onclick: () => {
        doc.checkpoint();
        L.params = structuredClone(def.params);
        doc.touch(L);
        changed('structure');
      } }, 'Reset'),
    ]));
    box.append(el('p', { class: 'prop-note' }, 'This layer changes the colors of every layer below it. Use “Clip” to change only the layer just below.'));
    return;
  }

  if (L.type === 'text') {
    $('props-title').textContent = 'Text';
    box.append(textProps(L));
    box.append(el('h2', { style: 'margin-top:14px' }, 'Transform'), transformProps(L));
    box.append(el('div', { class: 'prop-row', style: 'margin-top:10px' }, [
      el('button', { class: 'btn small', onclick: () => rasterize(L), title: 'Turns the text into normal pixels so you can paint on it' }, 'Turn into pixels'),
    ]));
    return;
  }

  $('props-title').textContent = L.name;
  box.append(el('div', { class: 'prop-row' }, [
    el('button', { class: 'btn small primary', onclick: () => removeBackground(L), title: 'The AI finds the subject (best with people) and hides the rest with a mask' }, '🤖 Remove background'),
  ]));
  box.append(transformProps(L));
  const src = L.canvas;
  box.append(el('p', { class: 'prop-note', style: 'margin-top:10px' }, `Pixels: ${src.width} × ${src.height}`));
}

function rasterize(L) {
  doc.checkpoint();
  const c = cloneCanvas(textCanvas(L));
  for (const k of ['text', 'font', 'size', 'color', 'bold', 'italic', 'align', 'lineHeight', '_key', '_canvas']) delete L[k];
  L.type = 'image';
  L.canvas = c;
  doc.touch(L);
  changed('structure');
}

// ---------------------------------------------------------------- opening pictures
async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    const f = Math.min(1, MAX_SIDE / Math.max(w, h));
    if (f < 1) { w = Math.round(w * f); h = Math.round(h * f); }
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas: c, scaled: f < 1, name: (file.name || 'Photo').replace(/\.[^.]+$/, '') };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function startDoc(newDoc) {
  doc = newDoc;
  doc.on(() => changed('structure'));
  $('empty').hidden = true;
  $('app').hidden = false;
  for (const b of document.querySelectorAll('.needs-doc')) b.disabled = false;
  requestAnimationFrame(() => {
    fit();
    setTool(toolName);
    changed('structure');
  });
}

async function openFile(file) {
  if (!file || !file.type.startsWith('image/')) { if (file) toast('That file is not a picture.'); return; }
  try {
    const { canvas, scaled, name } = await loadImage(file);
    const d = new Doc(canvas.width, canvas.height);
    d.addLayer(d.newImageLayer(canvas, name));
    $('export-name').value = `${name}-viveditor`;
    startDoc(d);
    if (scaled) toast(`Big photo: reduced to ${canvas.width} × ${canvas.height} to keep things fast.`);
  } catch (err) {
    console.error(err);
    toast('Sorry, this picture could not be opened.');
  }
}

async function addFile(file) {
  if (!doc) return openFile(file);
  if (!file || !file.type.startsWith('image/')) return;
  try {
    const { canvas, name } = await loadImage(file);
    doc.checkpoint();
    const L = doc.newImageLayer(canvas, name);
    const f = Math.min(1, (doc.width * 0.9) / canvas.width, (doc.height * 0.9) / canvas.height);
    L.tf.sx = L.tf.sy = f;
    doc.addLayer(L);
    changed('structure');
    setTool('move');
  } catch (err) {
    console.error(err);
    toast('Sorry, this picture could not be opened.');
  }
}

$('btn-open').onclick = () => $('open-file').click();
$('btn-add').onclick = () => $('add-file').click();
$('open-file').onchange = () => { openFile($('open-file').files[0]); $('open-file').value = ''; };
$('add-file').onchange = () => { addFile($('add-file').files[0]); $('add-file').value = ''; };

const dropzone = $('dropzone');
window.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
window.addEventListener('dragleave', () => dropzone.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (doc) addFile(f); else openFile(f);
});
window.addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
  if (item) { e.preventDefault(); addFile(item.getAsFile()); }
});

// ---------------------------------------------------------------- new picture
const newDialog = $('new-dialog');
function openNewDialog() { newDialog.showModal(); }
$('btn-new').onclick = openNewDialog;
$('btn-new-empty').onclick = openNewDialog;
$('new-presets').onclick = (e) => {
  const b = e.target.closest('[data-size]');
  if (!b) return;
  const [w, h] = b.dataset.size.split('x');
  $('new-w').value = w;
  $('new-h').value = h;
};
newDialog.addEventListener('close', () => {
  if (newDialog.returnValue !== 'ok') return;
  const w = Math.min(8000, Math.max(1, Math.round(Number($('new-w').value) || 1080)));
  const h = Math.min(8000, Math.max(1, Math.round(Number($('new-h').value) || 1080)));
  const d = new Doc(w, h);
  const c = makeCanvas(w, h);
  const bg = $('new-bg').value;
  if (bg !== 'transparent') {
    const ctx = c.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  d.addLayer(d.newImageLayer(c, 'Background'));
  $('export-name').value = 'viveditor';
  startDoc(d);
});

// ---------------------------------------------------------------- export
const exportDialog = $('export-dialog');

const FORMATS = {
  'image/png': { ext: 'png', note: 'Keeps transparency.' },
  'image/jpeg': { ext: 'jpg', quality: true, note: 'Transparent areas become white.' },
  'image/webp': { ext: 'webp', quality: true, note: 'Small files, keeps transparency.' },
  'image/tiff': { ext: 'tif', note: 'Uncompressed: big file, best for printing and other programs.' },
  'application/pdf': { ext: 'pdf', quality: true, note: 'One page; the size is the picture at 150 dpi.' },
  'image/vnd.adobe.photoshop': { ext: 'psd', note: 'Photoshop file with your layers, masks, blend modes and clipping. Text and adjustment layers become normal pixel layers.' },
};

function updateExportUi() {
  const fmt = $('export-format').value;
  $('export-quality-field').hidden = !FORMATS[fmt].quality;
  $('export-quality-value').textContent = $('export-quality').value;
  $('export-info').textContent = `${doc.width} × ${doc.height} pixels · ${FORMATS[fmt].note}`;
}
$('export-format').onchange = updateExportUi;
$('export-quality').oninput = updateExportUi;

$('btn-export').onclick = () => {
  if (!doc) return;
  updateExportUi();
  // Show "Share / Save to Photos" on phones that support sharing files.
  const test = new File([''], 'x.png', { type: 'image/png' });
  $('export-share').hidden = !(navigator.canShare && navigator.canShare({ files: [test] }));
  exportDialog.showModal();
};

async function makeExportFile() {
  const fmt = $('export-format').value;
  const quality = Number($('export-quality').value) / 100;
  const { ext } = FORMATS[fmt];
  const name = `${($('export-name').value || 'viveditor').replace(/[\\/:*?"<>|]+/g, '-')}.${ext}`;
  let blob;
  if (fmt === 'image/vnd.adobe.photoshop') {
    blob = await makePsd(doc);
  } else {
    const out = renderer.render(doc, { useCache: false });
    if (fmt === 'image/tiff') blob = makeTiff(out);
    else if (fmt === 'application/pdf') blob = await makePdf(out, 150, quality);
    else {
      let src = out;
      if (fmt === 'image/jpeg') {
        src = makeCanvas(doc.width, doc.height);
        const ctx = src.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, doc.width, doc.height);
        ctx.drawImage(out, 0, 0);
      }
      blob = await new Promise((res) => src.toBlob(res, fmt, quality));
      if (!blob) throw new Error('This browser could not create the file.');
      // Some browsers (older Safari) silently make PNG when asked for WebP.
      if (blob.type !== fmt) return new File([blob], name.replace(/\.[^.]+$/, '.png'), { type: blob.type });
    }
  }
  return new File([blob], name, { type: blob.type });
}

async function runExport(action) {
  const go = $('export-go');
  const share = $('export-share');
  go.disabled = share.disabled = true;
  $('export-info').textContent = 'Preparing the file…';
  try {
    const file = await makeExportFile();
    if (action === 'share') {
      await navigator.share({ files: [file], title: file.name });
    } else {
      const url = URL.createObjectURL(file);
      const a = el('a', { href: url, download: file.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
    $('export-info').textContent = `Saved ${file.name} (${(file.size / 1e6).toFixed(2)} MB)`;
  } catch (err) {
    if (err.name !== 'AbortError') $('export-info').textContent = `Export failed: ${err.message}`;
    else updateExportUi();
  } finally {
    go.disabled = share.disabled = false;
  }
}
$('export-go').onclick = () => runExport('download');
$('export-share').onclick = () => runExport('share');

// ---------------------------------------------------------------- undo / redo & keyboard
$('btn-undo').onclick = () => { if (doc && doc.undo()) afterHistory(); };
$('btn-redo').onclick = () => { if (doc && doc.redo()) afterHistory(); };
function afterHistory() {
  if (tool.activate && toolName === 'crop') tool.activate();
  renderToolOptions();
}

const KEYS = { v: 'move', c: 'crop', b: 'brush', e: 'eraser', s: 'clone', j: 'heal', t: 'text', m: 'marquee', l: 'lasso', w: 'wand', h: 'hand' };

window.addEventListener('keydown', (e) => {
  if (!doc || $('app').hidden) return;
  if (e.target.closest && e.target.closest('input, textarea, select, dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? $('btn-redo').click() : $('btn-undo').click(); return; }
  if (mod && k === 'y') { e.preventDefault(); $('btn-redo').click(); return; }
  if (mod && k === 'a') { e.preventDefault(); selection('all'); return; }
  if (mod && k === 'd') { e.preventDefault(); selection('none'); return; }
  if (mod && e.shiftKey && k === 'i') { e.preventDefault(); selection('invert'); return; }
  if (mod && k === 's') { e.preventDefault(); $('btn-export').click(); return; }
  if (mod) return;
  if (e.code === 'Space') { e.preventDefault(); if (!spaceHand) { spaceHand = true; scroller.style.cursor = 'grab'; } return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && doc.selection) { e.preventDefault(); selection('delete'); return; }
  if (e.key === 'Enter' && toolName === 'crop') { tools.crop.apply(); return; }
  if (e.key === 'Escape' && doc.selection) { selection('none'); return; }
  if (e.key === '[') { opts.size = Math.max(1, Math.round(opts.size / 1.2)); renderToolOptions(); changed('overlay'); return; }
  if (e.key === ']') { opts.size = Math.min(400, Math.round(opts.size * 1.2)); renderToolOptions(); changed('overlay'); return; }
  if (e.key === '+' || e.key === '=') { zoomCenter(1.25); return; }
  if (e.key === '-') { zoomCenter(0.8); return; }
  if (e.key === '0') { fit(); return; }
  if (KEYS[k]) setTool(KEYS[k]);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceHand) { spaceHand = false; scroller.style.cursor = tool.cursor || 'default'; }
});

// ---------------------------------------------------------------- small message at the bottom
let toastTimer = 0;
function toast(msg, duration = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  if (duration) toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}
function hideToast() {
  clearTimeout(toastTimer);
  $('toast').classList.remove('show');
}

for (const b of document.querySelectorAll('.needs-doc')) b.disabled = true;

// For automated tests and curious people: window.viveditor gives access to the editor.
window.viveditor = { get doc() { return doc; }, app, tools, setTool, selection, removeBackground, selectSubject, aiRemoveSelection };
