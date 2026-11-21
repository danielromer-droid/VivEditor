// formats.js — saving the picture as TIFF, PDF and PSD (Photoshop).
// PNG, JPEG and WebP are made by the browser itself (canvas.toBlob).

import { makeCanvas, layerMatrix } from './doc.js';
import { Renderer, layerSource } from './render.js';
import { ADJUSTMENTS } from './adjust.js';

// ---------------------------------------------------------------- TIFF
// An uncompressed RGBA TIFF: big files, but every program can open them.
export function makeTiff(canvas, dpi = 72) {
  const w = canvas.width;
  const h = canvas.height;
  const pixels = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const entries = [];
  const tag = (id, type, count, value) => entries.push({ id, type, count, value });
  // types: 3 = SHORT (2 bytes), 4 = LONG (4 bytes), 5 = RATIONAL (2 longs)
  const headerSize = 8;
  const ifdCount = 14;
  const ifdSize = 2 + ifdCount * 12 + 4;
  const extraStart = headerSize + ifdSize;
  const bitsOffset = extraStart; // 4 shorts = 8 bytes
  const xresOffset = bitsOffset + 8;
  const yresOffset = xresOffset + 8;
  const dataOffset = yresOffset + 8;
  tag(256, 4, 1, w); // width
  tag(257, 4, 1, h); // height
  tag(258, 3, 4, bitsOffset); // 8 bits per channel
  tag(259, 3, 1, 1); // no compression
  tag(262, 3, 1, 2); // RGB
  tag(273, 4, 1, dataOffset); // where the pixels start
  tag(277, 3, 1, 4); // 4 channels
  tag(278, 4, 1, h); // rows per strip
  tag(279, 4, 1, w * h * 4); // pixel bytes
  tag(282, 5, 1, xresOffset); // X resolution
  tag(283, 5, 1, yresOffset); // Y resolution
  tag(284, 3, 1, 1); // channels stored together
  tag(296, 3, 1, 2); // resolution in inches
  tag(338, 3, 1, 2); // 4th channel = transparency

  const buf = new ArrayBuffer(dataOffset + w * h * 4);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49); // "II" = little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, headerSize, true);
  dv.setUint16(headerSize, entries.length, true);
  entries.forEach((e, k) => {
    const o = headerSize + 2 + k * 12;
    dv.setUint16(o, e.id, true);
    dv.setUint16(o + 2, e.type, true);
    dv.setUint32(o + 4, e.count, true);
    if (e.type === 3 && e.count === 1) dv.setUint16(o + 8, e.value, true);
    else dv.setUint32(o + 8, e.value, true);
  });
  dv.setUint32(headerSize + 2 + entries.length * 12, 0, true); // no next IFD
  for (let k = 0; k < 4; k++) dv.setUint16(bitsOffset + k * 2, 8, true);
  dv.setUint32(xresOffset, dpi, true); dv.setUint32(xresOffset + 4, 1, true);
  dv.setUint32(yresOffset, dpi, true); dv.setUint32(yresOffset + 4, 1, true);
  new Uint8Array(buf, dataOffset).set(pixels);
  return new Blob([buf], { type: 'image/tiff' });
}

// ---------------------------------------------------------------- PDF
// One page the size of the picture (at `dpi` dots per inch) with the picture as a JPEG.
export async function makePdf(canvas, dpi = 150, quality = 0.92) {
  const w = canvas.width;
  const h = canvas.height;
  const flat = makeCanvas(w, h);
  const fctx = flat.getContext('2d');
  fctx.fillStyle = '#fff';
  fctx.fillRect(0, 0, w, h);
  fctx.drawImage(canvas, 0, 0);
  const jpeg = new Uint8Array(await (await new Promise((res) => flat.toBlob(res, 'image/jpeg', quality))).arrayBuffer());
  flat.width = 0;

  const pw = (w * 72) / dpi; // PDF sizes are in points (1/72 inch)
  const ph = (h * 72) / dpi;
  const content = `q ${pw.toFixed(2)} 0 0 ${ph.toFixed(2)} 0 0 cm /Im0 Do Q`;
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let length = 0;
  const add = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n, body) => { offsets[n] = length; add(`${n} 0 obj\n`); body(); add('\nendobj\n'); };

  add('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, () => add('<< /Type /Catalog /Pages 2 0 R >>'));
  obj(2, () => add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'));
  obj(3, () => add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`));
  obj(4, () => {
    add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`);
    add(jpeg);
    add('\nendstream');
  });
  obj(5, () => add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  obj(6, () => add('<< /Producer (VivEditor) >>'));
  const xref = length;
  let table = 'xref\n0 7\n0000000000 65535 f \n';
  for (let n = 1; n <= 6; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  add(`${table}trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}

// ---------------------------------------------------------------- PSD
// Uses the ag-psd library (MIT), loaded only when needed because it is large.
let agPsdPromise = null;
function loadAgPsd() {
  if (window.agPsd) return Promise.resolve(window.agPsd);
  if (!agPsdPromise) {
    agPsdPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../lib/ag-psd.min.js', import.meta.url).href;
      s.onload = () => resolve(window.agPsd);
      s.onerror = () => { agPsdPromise = null; reject(new Error('Could not load the PSD library.')); };
      document.head.append(s);
    });
  }
  return agPsdPromise;
}

const PSD_BLEND = {
  'source-over': 'normal', darken: 'darken', multiply: 'multiply', 'color-burn': 'color burn',
  lighten: 'lighten', screen: 'screen', 'color-dodge': 'color dodge', overlay: 'overlay',
  'soft-light': 'soft light', 'hard-light': 'hard light', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

// Masks in VivEditor are "opaque = visible"; Photoshop wants white = visible, black = hidden.
function psdMask(mask) {
  const c = makeCanvas(mask.width, mask.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(mask, 0, 0);
  return { top: 0, left: 0, bottom: c.height, right: c.width, defaultColor: 0, canvas: c };
}

/**
 * Photoshop file with one Photoshop layer per VivEditor layer (names, visibility,
 * opacity, blend modes, masks and clipping are kept). Text and adjustment layers
 * are saved as normal pixel layers that look the same.
 */
export async function makePsd(doc) {
  const agPsd = await loadAgPsd();
  const W = doc.width;
  const H = doc.height;
  const children = [];
  for (let i = 0; i < doc.layers.length; i++) {
    const L = doc.layers[i];
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    let name = L.name;
    if (L.type === 'adjust') {
      // Bake: what everything below looks like after this adjustment.
      const below = new Renderer().render({ width: W, height: H, layers: doc.layers.slice(0, i), activeIndex: -1 }, { useCache: false });
      ctx.drawImage(below, 0, 0);
      const img = ctx.getImageData(0, 0, W, H);
      ADJUSTMENTS[L.kind].apply(img.data, W, H, L.params, canvas);
      ctx.putImageData(img, 0, 0);
      name = `${L.name} (applied)`;
    } else {
      const src = layerSource(L);
      ctx.setTransform(layerMatrix(L, src.width, src.height));
      ctx.drawImage(src, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    const layer = {
      name,
      top: 0,
      left: 0,
      canvas,
      opacity: L.opacity,
      hidden: !L.visible,
      blendMode: PSD_BLEND[L.blend] || 'normal',
      clipping: !!(L.clip && i > 0),
    };
    if (L.mask) layer.mask = psdMask(L.mask);
    children.push(layer);
  }
  const composite = new Renderer().render({ width: W, height: H, layers: doc.layers, activeIndex: -1 }, { useCache: false });
  const bytes = agPsd.writePsd({ width: W, height: H, children, canvas: composite }, { generateThumbnail: false });
  return new Blob([bytes], { type: 'image/vnd.adobe.photoshop' });
}
