// heal.js — Spot Healing: fill an area with texture from nearby, matched to the colors around it.
//
// How it works:
//   1. Look around the area for a patch whose border looks most like the border
//      of the area to fix (the "best match").
//   2. Copy that patch in.
//   3. Fix the colors: measure the difference between the patch and the photo on the
//      border, and spread that difference smoothly inside (a "membrane").
//      So the texture comes from the patch, and the colors blend in with the surroundings.

import { makeCanvas } from './doc.js';

/**
 * @param {HTMLCanvasElement} source  picture to take pixels from (picture-sized)
 * @param {HTMLCanvasElement} mask    picture-sized; opaque where to heal
 * @param {{x:number,y:number,w:number,h:number}} bbox  area covered by the mask
 * @returns {{canvas: HTMLCanvasElement, x:number, y:number} | null}
 *          healed pixels for the area (already cut to the mask's soft edges)
 */
export function heal(source, mask, bbox) {
  const W = source.width;
  const H = source.height;
  const size = Math.max(bbox.w, bbox.h);
  const pad = Math.max(4, Math.round(size * 0.25));
  // the box we work in: the area plus a border of known pixels
  const bx = Math.max(0, Math.floor(bbox.x - pad));
  const by = Math.max(0, Math.floor(bbox.y - pad));
  const bw = Math.min(W, Math.ceil(bbox.x + bbox.w + pad)) - bx;
  const bh = Math.min(H, Math.ceil(bbox.y + bbox.h + pad)) - by;
  if (bw < 3 || bh < 3) return null;

  // Read a bigger area around it once, to search for the best patch.
  const R = Math.max(20, Math.round(size * 2 + pad));
  const sx0 = Math.max(0, bx - R);
  const sy0 = Math.max(0, by - R);
  const sw = Math.min(W, bx + bw + R) - sx0;
  const sh = Math.min(H, by + bh + R) - sy0;
  const sctx = source.getContext('2d', { willReadFrequently: true });
  const src = sctx.getImageData(sx0, sy0, sw, sh).data;
  const mk = mask.getContext('2d', { willReadFrequently: true }).getImageData(bx, by, bw, bh).data;

  const n = bw * bh;
  const unknown = new Uint8Array(n);
  let unknownCount = 0;
  for (let i = 0; i < n; i++) if (mk[i * 4 + 3] > 8) { unknown[i] = 1; unknownCount++; }
  if (!unknownCount) return null;

  // pixel of the source at picture coords (x, y), channel c
  const at = (x, y, c) => src[((y - sy0) * sw + (x - sx0)) * 4 + c];

  // border pixels used to compare candidates (a sample of them, for speed)
  const ring = [];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (unknown[y * bw + x]) continue;
      // keep pixels close to the area
      let near = false;
      for (let d = 1; d <= 3 && !near; d++) {
        if ((x >= d && unknown[y * bw + x - d]) || (x + d < bw && unknown[y * bw + x + d]) ||
          (y >= d && unknown[(y - d) * bw + x]) || (y + d < bh && unknown[(y + d) * bw + x])) near = true;
      }
      if (near) ring.push(x, y);
    }
  }
  const stride = Math.max(1, Math.floor(ring.length / 2 / 600)) * 2;

  const score = (dx, dy, limit) => {
    let s = 0;
    for (let k = 0; k < ring.length; k += stride) {
      const x = bx + ring[k];
      const y = by + ring[k + 1];
      for (let c = 0; c < 3; c++) {
        const d = at(x, y, c) - at(x + dx, y + dy, c);
        s += d * d;
      }
      if (s > limit) return s;
    }
    return s;
  };

  // A candidate patch must be inside the picture and must not overlap the area itself.
  const ok = (dx, dy) => {
    if (bx + dx < sx0 || by + dy < sy0 || bx + dx + bw > sx0 + sw || by + dy + bh > sy0 + sh) return false;
    const overlapX = Math.abs(dx) < bbox.w + pad;
    const overlapY = Math.abs(dy) < bbox.h + pad;
    return !(overlapX && overlapY);
  };

  let best = null;
  let bestScore = Infinity;
  const step = Math.max(1, Math.round(size / 8));
  for (let dy = -R; dy <= R; dy += step) {
    for (let dx = -R; dx <= R; dx += step) {
      if (!ok(dx, dy)) continue;
      const s = score(dx, dy, bestScore) * (1 + Math.hypot(dx, dy) / (R * 4)); // prefer close patches
      if (s < bestScore) { bestScore = s; best = [dx, dy]; }
    }
  }
  if (best && step > 1) {
    const [cx, cy] = best;
    for (let dy = cy - step; dy <= cy + step; dy++) {
      for (let dx = cx - step; dx <= cx + step; dx++) {
        if (!ok(dx, dy)) continue;
        const s = score(dx, dy, bestScore) * (1 + Math.hypot(dx, dy) / (R * 4));
        if (s < bestScore) { bestScore = s; best = [dx, dy]; }
      }
    }
  }

  // Build the result in the box.
  const out = new ImageData(bw, bh);
  const od = out.data;
  const diff = new Float32Array(n * 3);
  const [ox, oy] = best || [0, 0];
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      const X = bx + x;
      const Y = by + y;
      for (let c = 0; c < 3; c++) {
        const target = at(X, Y, c);
        const patch = best ? at(X + ox, Y + oy, c) : 0;
        diff[i * 3 + c] = unknown[i] ? 0 : target - patch;
      }
      od[i * 4 + 3] = best ? at(X + ox, Y + oy, 3) : at(X, Y, 3);
    }
  }
  solveMembrane(diff, unknown, bw, bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = y * bw + x;
      for (let c = 0; c < 3; c++) {
        const patch = best ? at(bx + x + ox, by + y + oy, c) : 0;
        od[i * 4 + c] = patch + diff[i * 3 + c];
      }
    }
  }

  const c = makeCanvas(bw, bh);
  const ctx = c.getContext('2d');
  ctx.putImageData(out, 0, 0);
  // keep only the masked area (with its soft edges)
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, bx, by, bw, bh, 0, 0, bw, bh);
  return { canvas: c, x: bx, y: by };
}

// Fill unknown values smoothly from the known ones around them (like a soap film).
// Works coarse-to-fine so big areas settle quickly.
function solveMembrane(v, unknown, w, h) {
  const n = w * h;
  if (w > 24 && h > 24) {
    const w2 = Math.ceil(w / 2);
    const h2 = Math.ceil(h / 2);
    const v2 = new Float32Array(w2 * h2 * 3);
    const u2 = new Uint8Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        let cnt = 0;
        const sum = [0, 0, 0];
        for (let yy = y * 2; yy < Math.min(h, y * 2 + 2); yy++) {
          for (let xx = x * 2; xx < Math.min(w, x * 2 + 2); xx++) {
            const i = yy * w + xx;
            if (!unknown[i]) { cnt++; for (let c = 0; c < 3; c++) sum[c] += v[i * 3 + c]; }
          }
        }
        const j = y * w2 + x;
        if (cnt) for (let c = 0; c < 3; c++) v2[j * 3 + c] = sum[c] / cnt;
        else u2[j] = 1;
      }
    }
    solveMembrane(v2, u2, w2, h2);
    for (let i = 0; i < n; i++) {
      if (!unknown[i]) continue;
      const x = i % w;
      const y = (i / w) | 0;
      const j = (y >> 1) * w2 + (x >> 1);
      for (let c = 0; c < 3; c++) v[i * 3 + c] = v2[j * 3 + c];
    }
  } else {
    // start from the average of the known values
    const avg = [0, 0, 0];
    let cnt = 0;
    for (let i = 0; i < n; i++) if (!unknown[i]) { cnt++; for (let c = 0; c < 3; c++) avg[c] += v[i * 3 + c]; }
    if (cnt) for (let i = 0; i < n; i++) if (unknown[i]) for (let c = 0; c < 3; c++) v[i * 3 + c] = avg[c] / cnt;
  }
  const iterations = w * h < 2500 ? 200 : 40;
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!unknown[i]) continue;
        let k = 0;
        let s0 = 0; let s1 = 0; let s2 = 0;
        if (x > 0) { const j = (i - 1) * 3; s0 += v[j]; s1 += v[j + 1]; s2 += v[j + 2]; k++; }
        if (x < w - 1) { const j = (i + 1) * 3; s0 += v[j]; s1 += v[j + 1]; s2 += v[j + 2]; k++; }
        if (y > 0) { const j = (i - w) * 3; s0 += v[j]; s1 += v[j + 1]; s2 += v[j + 2]; k++; }
        if (y < h - 1) { const j = (i + w) * 3; s0 += v[j]; s1 += v[j + 1]; s2 += v[j + 2]; k++; }
        v[i * 3] = s0 / k; v[i * 3 + 1] = s1 / k; v[i * 3 + 2] = s2 / k;
      }
    }
  }
}

// Bounding box of the opaque part of a picture-sized canvas (used for "Heal selection").
export function opaqueBounds(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
