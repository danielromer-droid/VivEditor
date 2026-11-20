// selection.js — a selection is a canvas the size of the picture:
// white (opaque) where selected, transparent where not.

import { makeCanvas } from './doc.js';

export function shapeSelection(w, h, shape) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  if (shape.type === 'rect') {
    ctx.rect(shape.x, shape.y, shape.w, shape.h);
  } else if (shape.type === 'ellipse') {
    ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
  } else if (shape.type === 'lasso') {
    shape.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  ctx.fill();
  return c;
}

// Magic wand: select pixels with a color close to the one clicked.
// `source` is a canvas (usually the whole picture), tolerance 0..255.
export function magicWand(source, px, py, tolerance, contiguous) {
  const w = source.width;
  const h = source.height;
  px = Math.floor(px); py = Math.floor(py);
  if (px < 0 || py < 0 || px >= w || py >= h) return null;
  const data = source.getContext('2d').getImageData(0, 0, w, h).data;
  const out = new ImageData(w, h);
  const od = out.data;
  const i0 = (py * w + px) * 4;
  const r0 = data[i0]; const g0 = data[i0 + 1]; const b0 = data[i0 + 2]; const a0 = data[i0 + 3];
  const tol = tolerance * tolerance * 3;
  const close = (i) => {
    const dr = data[i] - r0; const dg = data[i + 1] - g0; const db = data[i + 2] - b0; const da = data[i + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };
  const mark = (p) => { const i = p * 4; od[i] = od[i + 1] = od[i + 2] = od[i + 3] = 255; };

  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (close(p * 4)) mark(p);
  } else {
    // flood fill, row by row (scanline) so it's fast
    const seen = new Uint8Array(w * h);
    const stack = [px, py];
    while (stack.length) {
      const y = stack.pop();
      let x = stack.pop();
      let p = y * w + x;
      while (x >= 0 && !seen[p] && close(p * 4)) { x--; p--; }
      x++; p++;
      let up = false; let down = false;
      while (x < w && !seen[p] && close(p * 4)) {
        seen[p] = 1;
        mark(p);
        if (y > 0) {
          const q = p - w;
          if (!seen[q] && close(q * 4)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
        }
        if (y < h - 1) {
          const q = p + w;
          if (!seen[q] && close(q * 4)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
        }
        x++; p++;
      }
    }
  }
  const c = makeCanvas(w, h);
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

// Combine a new selection with the current one.
// mode: 'new' | 'add' (Shift) | 'subtract' (Alt)
export function combine(current, next, mode) {
  if (mode === 'new' || !current) return mode === 'subtract' ? current : next;
  const c = makeCanvas(current.width, current.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(current, 0, 0);
  ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : 'destination-out';
  ctx.drawImage(next, 0, 0);
  return isEmpty(c) ? null : c;
}

export function invertSelection(sel, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  if (sel) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(sel, 0, 0);
  }
  return c;
}

export function selectAll(w, h) {
  return invertSelection(null, w, h);
}

function isEmpty(c) {
  // check a shrunk copy: quick and good enough
  const s = makeCanvas(Math.min(256, c.width), Math.min(256, c.height));
  const ctx = s.getContext('2d');
  ctx.drawImage(c, 0, 0, s.width, s.height);
  const d = ctx.getImageData(0, 0, s.width, s.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return false;
  return true;
}

// Outline of the selection at screen size, drawn as black/white dashes ("marching ants").
export function selectionOutline(sel, outW, outH) {
  outW = Math.max(1, Math.round(outW)); outH = Math.max(1, Math.round(outH));
  const small = makeCanvas(outW, outH);
  const sctx = small.getContext('2d');
  sctx.drawImage(sel, 0, 0, outW, outH);
  const src = sctx.getImageData(0, 0, outW, outH).data;
  const out = new ImageData(outW, outH);
  const od = out.data;
  const inside = (x, y) => x >= 0 && y >= 0 && x < outW && y < outH && src[(y * outW + x) * 4 + 3] >= 128;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      if (!inside(x, y)) continue;
      if (inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1)) continue;
      const i = (y * outW + x) * 4;
      const v = ((x + y) >> 2) & 1 ? 255 : 0;
      od[i] = od[i + 1] = od[i + 2] = v;
      od[i + 3] = 255;
    }
  }
  sctx.putImageData(out, 0, 0);
  return small;
}
