// ai.js — AI tools that run inside your browser.
//
// Your photo is NEVER sent anywhere. What gets downloaded is the AI "model" (a file of
// numbers that knows how to recognise objects, people, textures), once, from Hugging Face.
// It is then kept in the browser's cache so the next time works offline.
//
// The models are run by ONNX Runtime Web (Microsoft, MIT licence), loaded from jsDelivr.
//
//   AI Select         SlimSAM (a small "Segment Anything", Apache-2.0): tap an object → its outline
//   Remove background MODNet (Apache-2.0): finds the person in a photo → a layer mask
//   AI Remove         MI-GAN (Picsart, MIT): fills a hole with a believable background

import { makeCanvas } from './doc.js';

const ORT_VERSION = '1.22.0';
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const HF = 'https://huggingface.co';

export const MODELS = {
  samEncoder: {
    label: 'AI Select',
    url: `${HF}/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/vision_encoder_quantized.onnx`,
    sha256: 'cce23c7b2e5d4f330932738fb67ba518e04b0d99ccdd1cccd22a7da4e01f2971',
    bytes: 8_882_165,
  },
  samDecoder: {
    label: 'AI Select',
    url: `${HF}/Xenova/slimsam-77-uniform/resolve/5850ab45f587c112167512ffef949107115e26a0/onnx/prompt_encoder_mask_decoder_quantized.onnx`,
    sha256: 'cb90b279f549d2cab7fd6e20c38522438c65d84bdcca3d2a764cff7d857fdce2',
    bytes: 4_903_810,
  },
  migan: {
    label: 'AI Remove',
    url: `${HF}/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx`,
    sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
    bytes: 28_079_181,
  },
  modnet: {
    label: 'Remove background',
    url: `${HF}/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model_quantized.onnx`,
    bytes: 6_632_188,
  },
};

// ---------------------------------------------------------------- loading
let ortPromise = null;
function loadOrt() {
  if (window.ort) return Promise.resolve(window.ort);
  if (!ortPromise) {
    ortPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${ORT_BASE}ort.wasm.min.js`;
      s.crossOrigin = 'anonymous';
      s.onload = () => {
        const ort = window.ort;
        ort.env.wasm.wasmPaths = ORT_BASE;
        // Several threads need special server headers that GitHub Pages can't send.
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
        resolve(ort);
      };
      s.onerror = () => { ortPromise = null; reject(new Error('Could not load the AI engine. Are you online?')); };
      document.head.append(s);
    });
  }
  return ortPromise;
}

const CACHE = 'viveditor-ai-models-v1';

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Download a model with progress (or take it from the cache).
async function fetchModel(model, onProgress) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* private mode: no cache */ }
  const hit = cache && await cache.match(model.url);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  const res = await fetch(model.url);
  if (!res.ok) throw new Error(`Could not download the AI model (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || model.bytes;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got / total);
  }
  const bytes = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { bytes.set(c, o); o += c.length; }
  if (model.sha256 && await sha256Hex(bytes) !== model.sha256) throw new Error('The AI model download was damaged. Please try again.');
  try { await cache?.put(model.url, new Response(bytes)); } catch { /* cache full: fine */ }
  return bytes;
}

const sessions = {};
async function session(name, onStatus) {
  if (!sessions[name]) {
    sessions[name] = (async () => {
      const ort = await loadOrt();
      const m = MODELS[name];
      const mb = Math.round(m.bytes / 1e6);
      const bytes = await fetchModel(m, (f) => onStatus?.(`Downloading the ${m.label} model (${mb} MB, only the first time)… ${Math.round(f * 100)}%`));
      onStatus?.(`Starting ${m.label}…`);
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    })();
    sessions[name].catch(() => { delete sessions[name]; });
  }
  return sessions[name];
}

// ---------------------------------------------------------------- helpers
function pixelsOf(canvas, x = 0, y = 0, w = canvas.width, h = canvas.height) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, w, h).data;
}

function scaled(canvas, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  return c;
}

// ---------------------------------------------------------------- AI Select (SlimSAM)
const SAM = 1024; // the model looks at the picture shrunk to 1024 px
const SAM_MASK = 256; // and answers with a 256 × 256 mask
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let samCache = { key: '', embedding: null };

/**
 * Selects the object under the points.
 * @param {HTMLCanvasElement} picture  what you see (all layers)
 * @param {string} key                 changes when the picture changes
 * @param {{x:number,y:number,positive:boolean}[]} points  in picture pixels
 * @returns {Promise<HTMLCanvasElement>} picture-sized selection (opaque = selected)
 */
export async function aiSelect(picture, key, points, onStatus) {
  const ort = await loadOrt();
  const encoder = await session('samEncoder', onStatus);
  const decoder = await session('samDecoder', onStatus);
  const W = picture.width;
  const H = picture.height;
  const s = SAM / Math.max(W, H);
  const fw = Math.max(1, Math.round(W * s));
  const fh = Math.max(1, Math.round(H * s));

  if (samCache.key !== key) {
    onStatus?.('Looking at the picture…');
    await new Promise((r) => setTimeout(r, 30)); // let the message appear
    const small = scaled(picture, fw, fh);
    const px = pixelsOf(small);
    small.width = 0;
    const plane = SAM * SAM;
    const input = new Float32Array(3 * plane); // zero padding outside the picture
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const i = (y * fw + x) * 4;
        const a = px[i + 3] / 255;
        for (let c = 0; c < 3; c++) input[c * plane + y * SAM + x] = ((px[i + c] / 255) * a - MEAN[c]) / STD[c];
      }
    }
    const out = await encoder.run({ pixel_values: new ort.Tensor('float32', input, [1, 3, SAM, SAM]) });
    samCache = { key, embedding: { image_embeddings: out.image_embeddings, image_positional_embeddings: out.image_positional_embeddings } };
  }

  onStatus?.('Finding the object…');
  const coords = Float32Array.from(points.flatMap((p) => [p.x * s, p.y * s]));
  const labels = BigInt64Array.from(points.map((p) => (p.positive ? 1n : 0n)));
  const out = await decoder.run({
    input_points: new ort.Tensor('float32', coords, [1, 1, points.length, 2]),
    input_labels: new ort.Tensor('int64', labels, [1, 1, points.length]),
    ...samCache.embedding,
  });
  // The model gives 3 guesses (whole object, part, smaller part): keep the most confident.
  const scores = Array.from(out.iou_scores.data);
  const best = scores.reduce((b, v, i) => (v > scores[b] ? i : b), 0);
  const plane = SAM_MASK * SAM_MASK;
  const logits = out.pred_masks.data.subarray(best * plane, (best + 1) * plane);

  // 256 × 256 mask → canvas → stretched to the picture, then made crisp.
  const m = makeCanvas(SAM_MASK, SAM_MASK);
  const img = new ImageData(SAM_MASK, SAM_MASK);
  for (let i = 0; i < plane; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = 255 / (1 + Math.exp(-logits[i]));
  }
  m.getContext('2d').putImageData(img, 0, 0);
  const k = SAM_MASK / SAM;
  const sel = makeCanvas(W, H);
  const sctx = sel.getContext('2d', { willReadFrequently: true });
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(m, 0, 0, fw * k, fh * k, 0, 0, W, H);
  const d = sctx.getImageData(0, 0, W, H);
  for (let i = 3; i < d.data.length; i += 4) {
    const a = d.data[i];
    d.data[i] = a < 96 ? 0 : a > 160 ? 255 : (a - 96) * 4; // sharp edge with a tiny soft border
  }
  sctx.putImageData(d, 0, 0);
  m.width = 0;
  return sel;
}

// ---------------------------------------------------------------- Remove background (MODNet)
/**
 * Finds the person (foreground) in a picture.
 * @returns {Promise<HTMLCanvasElement>} same size as `picture`; opaque where the person is
 */
export async function findForeground(picture, onStatus) {
  const ort = await loadOrt();
  const net = await session('modnet', onStatus);
  onStatus?.('Finding the subject…');
  await new Promise((r) => setTimeout(r, 30));
  const W = picture.width;
  const H = picture.height;
  // shortest side 512, both sides a multiple of 32 (what the model was trained with)
  const s = 512 / Math.min(W, H);
  const w = Math.max(32, Math.round((W * s) / 32) * 32);
  const h = Math.max(32, Math.round((H * s) / 32) * 32);
  const small = scaled(picture, w, h);
  const px = pixelsOf(small);
  small.width = 0;
  const plane = w * h;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) for (let c = 0; c < 3; c++) input[c * plane + i] = (px[i * 4 + c] / 255 - 0.5) / 0.5;
  const out = await net.run({ input: new ort.Tensor('float32', input, [1, 3, h, w]) });
  const matte = out.output.data;
  const m = makeCanvas(w, h);
  const img = new ImageData(w, h);
  for (let i = 0; i < plane; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.max(0, Math.min(255, matte[i] * 255));
  }
  m.getContext('2d').putImageData(img, 0, 0);
  const result = scaled(m, W, H);
  m.width = 0;
  return result;
}

// ---------------------------------------------------------------- AI Remove (MI-GAN)
/**
 * Fills the masked area with a believable background.
 * @param {HTMLCanvasElement} picture  pixels to look at (picture-sized)
 * @param {HTMLCanvasElement} mask     picture-sized; opaque = remove
 * @param {{x,y,w,h}} bbox             area covered by the mask
 * @returns {Promise<{canvas, x, y}>}  new pixels for the area (cut to the mask, slightly grown)
 */
export async function aiRemove(picture, mask, bbox, onStatus) {
  const ort = await loadOrt();
  const net = await session('migan', onStatus);
  onStatus?.('Removing…');
  await new Promise((r) => setTimeout(r, 30));
  const W = picture.width;
  const H = picture.height;
  // Work on a square around the area, about 3× its size (enough surroundings to copy from).
  const size = Math.min(Math.max(W, H), Math.max(256, Math.round(Math.max(bbox.w, bbox.h) * 3)));
  const cx = bbox.x + bbox.w / 2;
  const cy = bbox.y + bbox.h / 2;
  const x0 = Math.round(Math.max(0, Math.min(W - Math.min(size, W), cx - size / 2)));
  const y0 = Math.round(Math.max(0, Math.min(H - Math.min(size, H), cy - size / 2)));
  const w = Math.min(size, W);
  const h = Math.min(size, H);

  // Grow the hole a few pixels so no outline of the object is left behind.
  const grow = Math.max(3, Math.round(Math.max(bbox.w, bbox.h) * 0.04));
  const grown = makeCanvas(w, h);
  const gctx = grown.getContext('2d', { willReadFrequently: true });
  for (let a = 0; a < 8; a++) {
    const dx = Math.round(Math.cos((a * Math.PI) / 4) * grow);
    const dy = Math.round(Math.sin((a * Math.PI) / 4) * grow);
    gctx.drawImage(mask, x0, y0, w, h, dx, dy, w, h);
  }
  gctx.drawImage(mask, x0, y0, w, h, 0, 0, w, h);

  const px = pixelsOf(picture, x0, y0, w, h);
  const mk = gctx.getImageData(0, 0, w, h).data;
  const plane = w * h;
  const image = new Uint8Array(3 * plane);
  const hole = new Uint8Array(plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) image[c * plane + i] = px[i * 4 + c];
    hole[i] = mk[i * 4 + 3] > 20 ? 0 : 255; // 0 = fill this, 255 = keep
  }
  const out = await net.run({
    image: new ort.Tensor('uint8', image, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', hole, [1, 1, h, w]),
  });
  const res = out.result.data;
  const result = new ImageData(w, h);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) result.data[i * 4 + c] = res[c * plane + i];
    result.data[i * 4 + 3] = 255;
  }
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.putImageData(result, 0, 0);
  // keep only the (grown) hole, with soft edges
  ctx.globalCompositeOperation = 'destination-in';
  ctx.filter = 'blur(1px)';
  ctx.drawImage(grown, 0, 0);
  ctx.filter = 'none';
  grown.width = 0;
  return { canvas: c, x: x0, y: y0 };
}
