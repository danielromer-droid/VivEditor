// adjust.js — adjustment layers. Each one changes the colors of everything below it,
// without touching the original pixels (delete or hide the layer and it's gone).
//
// Each adjustment has: a label, default params, the sliders to show, and an `apply`
// function that changes an ImageData (the raw red/green/blue/alpha numbers, 0..255).

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

// Apply three 256-entry lookup tables (one per channel). Very fast.
function applyLuts(data, lr, lg, lb) {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lr[data[i]];
    data[i + 1] = lg[data[i + 1]];
    data[i + 2] = lb[data[i + 2]];
  }
}

function makeLut(fn) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = fn(v);
  return lut;
}

// A soft blur made by shrinking the picture and growing it back. Works in every browser.
function blurred(canvas, radius) {
  const w = canvas.width;
  const h = canvas.height;
  const f = Math.max(2, radius);
  const sw = Math.max(1, Math.round(w / f));
  const sh = Math.max(1, Math.round(h / f));
  const small = document.createElement('canvas');
  small.width = sw; small.height = sh;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  // two steps down for a smoother result
  const mid = document.createElement('canvas');
  mid.width = Math.max(1, Math.round(w / Math.sqrt(f))); mid.height = Math.max(1, Math.round(h / Math.sqrt(f)));
  const mctx = mid.getContext('2d');
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(canvas, 0, 0, mid.width, mid.height);
  sctx.drawImage(mid, 0, 0, sw, sh);
  const big = document.createElement('canvas');
  big.width = w; big.height = h;
  const bctx = big.getContext('2d', { willReadFrequently: true });
  bctx.imageSmoothingQuality = 'high';
  bctx.drawImage(small, 0, 0, w, h);
  const out = bctx.getImageData(0, 0, w, h).data;
  small.width = mid.width = big.width = 0;
  return out;
}

// ---- color helpers ----
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hslToRgb(h, s, l, out) {
  if (s === 0) { out[0] = out[1] = out[2] = l * 255; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  out[0] = hue2rgb(p, q, h + 1 / 3) * 255;
  out[1] = hue2rgb(p, q, h) * 255;
  out[2] = hue2rgb(p, q, h - 1 / 3) * 255;
}

// Smooth curve through points (monotone cubic, like Photoshop curves). Returns a LUT.
export function curveLut(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  if (n < 2) return makeLut((v) => v);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return makeLut((x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  });
}

// Stable "random" number for a pixel, so grain doesn't flicker when redrawn.
function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

export const ADJUSTMENTS = {
  brightness: {
    label: 'Brightness / Contrast',
    params: { brightness: 0, contrast: 0 },
    sliders: [['brightness', 'Brightness', -100, 100], ['contrast', 'Contrast', -100, 100]],
    apply(data, w, h, p) {
      const c = p.contrast * 2.55;
      const f = (259 * (c + 255)) / (255 * (259 - c));
      const b = p.brightness * 1.5;
      const lut = makeLut((v) => (v - 128) * f + 128 + b);
      applyLuts(data, lut, lut, lut);
    },
  },

  levels: {
    label: 'Levels',
    params: { inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 },
    sliders: [
      ['inBlack', 'Shadows (input black)', 0, 254],
      ['gamma', 'Midtones (gamma)', 0.1, 3, 0.01],
      ['inWhite', 'Highlights (input white)', 1, 255],
      ['outBlack', 'Output black', 0, 255],
      ['outWhite', 'Output white', 0, 255],
    ],
    apply(data, w, h, p) {
      const range = Math.max(1, p.inWhite - p.inBlack);
      const lut = makeLut((v) => {
        let x = Math.min(1, Math.max(0, (v - p.inBlack) / range));
        x = Math.pow(x, 1 / p.gamma);
        return p.outBlack + x * (p.outWhite - p.outBlack);
      });
      applyLuts(data, lut, lut, lut);
    },
  },

  curves: {
    label: 'Curves',
    params: { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] },
    custom: 'curves',
    apply(data, w, h, p) {
      const all = curveLut(p.rgb);
      const lr = curveLut(p.r);
      const lg = curveLut(p.g);
      const lb = curveLut(p.b);
      applyLuts(data, makeLut((v) => all[lr[v]]), makeLut((v) => all[lg[v]]), makeLut((v) => all[lb[v]]));
    },
  },

  hueSat: {
    label: 'Hue / Saturation',
    params: { hue: 0, saturation: 0, lightness: 0 },
    sliders: [['hue', 'Hue', -180, 180], ['saturation', 'Saturation', -100, 100], ['lightness', 'Lightness', -100, 100]],
    apply(data, w, h, p) {
      const dh = p.hue / 360;
      const ds = p.saturation / 100;
      const dl = p.lightness / 100;
      const out = [0, 0, 0];
      for (let i = 0; i < data.length; i += 4) {
        let [hh, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        hh = (hh + dh + 1) % 1;
        s = ds > 0 ? s + (1 - s) * ds : s * (1 + ds);
        s = Math.min(1, Math.max(0, s));
        l = dl > 0 ? l + (1 - l) * dl : l * (1 + dl);
        hslToRgb(hh, s, l, out);
        data[i] = out[0]; data[i + 1] = out[1]; data[i + 2] = out[2];
      }
    },
  },

  colorBalance: {
    label: 'Color Balance',
    params: { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserve: true },
    custom: 'colorBalance',
    apply(data, w, h, p) {
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const ws = Math.max(0, 1 - L * 2.2) ** 1.5; // shadows weight
        const wh = Math.max(0, L * 2.2 - 1.2) ** 1.5; // highlights weight
        const wm = Math.max(0, 1 - Math.abs(L - 0.5) * 2.5); // midtones weight
        const k = 0.8;
        let nr = r + k * (ws * p.shadows[0] + wm * p.midtones[0] + wh * p.highlights[0]);
        let ng = g + k * (ws * p.shadows[1] + wm * p.midtones[1] + wh * p.highlights[1]);
        let nb = b + k * (ws * p.shadows[2] + wm * p.midtones[2] + wh * p.highlights[2]);
        if (p.preserve) {
          const L2 = (0.299 * nr + 0.587 * ng + 0.114 * nb) / 255;
          const d = (L - L2) * 255;
          nr += d; ng += d; nb += d;
        }
        data[i] = nr; data[i + 1] = ng; data[i + 2] = nb;
      }
    },
  },

  blackWhite: {
    label: 'Black & White',
    params: { tint: 0 },
    sliders: [['tint', 'Warm tint (sepia)', 0, 100]],
    apply(data, w, h, p) {
      const t = p.tint / 100;
      for (let i = 0; i < data.length; i += 4) {
        const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        data[i] = y + 40 * t;
        data[i + 1] = y + 15 * t;
        data[i + 2] = y - 20 * t;
      }
    },
  },

  clarity: {
    label: 'Clarity',
    params: { amount: 40 },
    sliders: [['amount', 'Amount', -100, 100]],
    apply(data, w, h, p, canvas) {
      const blur = blurred(canvas, Math.max(8, Math.round(Math.min(w, h) / 40)));
      const a = p.amount / 100;
      for (let i = 0; i < data.length; i += 4) {
        const L = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
        const mid = 1 - Math.abs(L * 2 - 1); // strongest in the midtones
        const k = a * (0.4 + mid);
        data[i] = clamp255(data[i] + k * (data[i] - blur[i]));
        data[i + 1] = clamp255(data[i + 1] + k * (data[i + 1] - blur[i + 1]));
        data[i + 2] = clamp255(data[i + 2] + k * (data[i + 2] - blur[i + 2]));
      }
    },
  },

  dehaze: {
    label: 'Dehaze',
    params: { amount: 40 },
    sliders: [['amount', 'Amount (negative adds haze)', -100, 100]],
    apply(data, w, h, p, canvas) {
      const a = p.amount / 100;
      const A = 245; // the color of the haze (near white)
      if (a < 0) {
        for (let i = 0; i < data.length; i += 4) {
          for (let c = 0; c < 3; c++) data[i + c] = data[i + c] + (A - data[i + c]) * -a * 0.6;
        }
        return;
      }
      // "Dark channel": in clear areas at least one color is dark; haze lifts all of them.
      const dark = document.createElement('canvas');
      dark.width = w; dark.height = h;
      const dctx = dark.getContext('2d');
      const dimg = dctx.createImageData(w, h);
      const dd = dimg.data;
      for (let i = 0; i < data.length; i += 4) {
        const m = Math.min(data[i], data[i + 1], data[i + 2]);
        dd[i] = dd[i + 1] = dd[i + 2] = m;
        dd[i + 3] = 255;
      }
      dctx.putImageData(dimg, 0, 0);
      const haze = blurred(dark, Math.max(8, Math.round(Math.min(w, h) / 30)));
      dark.width = 0;
      for (let i = 0; i < data.length; i += 4) {
        const t = Math.max(0.25, 1 - 0.95 * a * (haze[i] / A));
        for (let c = 0; c < 3; c++) data[i + c] = clamp255((data[i + c] - A) / t + A);
      }
    },
  },

  grain: {
    label: 'Grain',
    params: { amount: 25, size: 1 },
    sliders: [['amount', 'Amount', 0, 100], ['size', 'Size', 1, 4, 1]],
    apply(data, w, h, p) {
      const a = p.amount * 0.9;
      const s = Math.max(1, Math.round(p.size));
      for (let y = 0; y < h; y++) {
        const gy = Math.floor(y / s);
        for (let x = 0; x < w; x++) {
          const n = (hash(Math.floor(x / s), gy) - 0.5) * a;
          const i = (y * w + x) * 4;
          data[i] += n; data[i + 1] += n; data[i + 2] += n;
        }
      }
    },
  },

  invert: {
    label: 'Invert',
    params: {},
    sliders: [],
    apply(data) {
      const lut = makeLut((v) => 255 - v);
      applyLuts(data, lut, lut, lut);
    },
  },
};
