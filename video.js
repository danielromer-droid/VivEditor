// video.js — connects the buttons, the timeline and the export panel.
import { exportMp4, browserCanExport, computeOutput, estimateBitrate } from './exporter.js';
import { Timeline } from './timeline.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const frame = $('frame');
const viewer = frame.parentElement;
let currentFile = null;
let downloadUrl = null;
let exporting = false;

const settings = { aspect: 'original', shortSide: 0, quality: 'medium', mute: false };

// 1:07.5 style display
function formatTime(s) {
  s = Math.max(0, s);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

if (!browserCanExport()) {
  $('support').hidden = false;
  $('support').textContent = 'Heads up: this browser can open videos but cannot export MP4. Use a recent Chrome, Edge, Safari or Firefox.';
}

// ---------- opening a video ----------

function openFile(file) {
  if (!file || !file.type.startsWith('video/') && !/\.(mp4|mov|webm|mkv|m4v)$/i.test(file.name)) return;
  if (exporting) return;
  currentFile = file;
  if (video.src) URL.revokeObjectURL(video.src);
  // A "blob URL" points to the file on your device. Nothing is sent anywhere.
  video.src = URL.createObjectURL(file);
  $('download').hidden = true;
  setStatus('');
}

$('file').addEventListener('change', () => openFile($('file').files[0]));

// Drag and drop a file anywhere on the page.
const dropzone = $('dropzone');
window.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
window.addEventListener('dragleave', () => dropzone.classList.remove('over'));
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  openFile(e.dataTransfer.files[0]);
});

video.addEventListener('loadedmetadata', () => {
  $('empty').hidden = true;
  $('editor').hidden = false;
  fitFrame();
  timeline.load(video.duration, currentFile);
  updateCropBox();
});

video.addEventListener('error', () => {
  $('support').hidden = false;
  $('support').textContent = 'This browser cannot read that video file. Try an MP4 or MOV.';
});

// Size the video box to the video's own shape, as big as fits.
function fitFrame() {
  if (!video.videoWidth) return;
  const ratio = video.videoWidth / video.videoHeight;
  const maxW = viewer.clientWidth;
  const maxH = viewer.clientHeight;
  let w = maxW;
  let h = w / ratio;
  if (h > maxH) { h = maxH; w = h * ratio; }
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
}
new ResizeObserver(fitFrame).observe(viewer);

// ---------- timeline ----------

const timeline = new Timeline({
  root: $('timeline'),
  canvas: $('thumbs'),
  segmentsLayer: $('segments'),
  playhead: $('playhead'),
  video,
  onChange: () => {
    $('time-total').textContent = formatTime(timeline.editedDuration);
    $('delete').disabled = timeline.segments.length <= 1;
    updateSummary();
  },
  onSeek: (t) => {
    stopPlayback();
    video.currentTime = t;
  },
});

// Keep the playhead and clock moving smoothly.
function tick() {
  timeline.updatePlayhead();
  $('time-now').textContent = formatTime(editedTimeAt(video.currentTime));
  if (playing) followEdit();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Where are we in the finished video? (cut parts don't count)
function editedTimeAt(t) {
  let acc = 0;
  for (const s of timeline.segments) {
    if (t >= s.end) acc += s.end - s.start;
    else { if (t > s.start) acc += t - s.start; break; }
  }
  return acc;
}

// ---------- playing the edit (skipping the cut parts) ----------

let playing = false;

function followEdit() {
  const t = video.currentTime;
  const segs = timeline.segments;
  const inside = segs.find((s) => t >= s.start && t < s.end - 0.02);
  if (inside) return;
  const next = segs.find((s) => s.start > t - 0.02);
  if (next) video.currentTime = next.start; // jump over the cut part
  else stopPlayback();
}

function startPlayback() {
  const segs = timeline.segments;
  const t = video.currentTime;
  // Start from the playhead, or from the beginning if we're at the end.
  if (!segs.some((s) => t >= s.start && t < s.end - 0.05)) {
    const next = segs.find((s) => s.start > t);
    video.currentTime = next ? next.start : segs[0].start;
  }
  playing = true;
  video.play();
  $('play').textContent = '❚❚';
  $('play').setAttribute('aria-label', 'Pause');
}

function stopPlayback() {
  playing = false;
  video.pause();
  $('play').textContent = '▶';
  $('play').setAttribute('aria-label', 'Play');
}

$('play').addEventListener('click', () => (playing ? stopPlayback() : startPlayback()));
video.addEventListener('click', () => (playing ? stopPlayback() : startPlayback()));
video.addEventListener('ended', stopPlayback);

$('split').addEventListener('click', () => {
  if (!timeline.split(video.currentTime)) setStatus('Move the playhead inside a part to split it.');
});
$('delete').addEventListener('click', () => timeline.deleteSelected());
$('reset').addEventListener('click', () => timeline.reset());

// Keyboard shortcuts: space = play/pause, S = split, Delete = remove part.
window.addEventListener('keydown', (e) => {
  if ($('editor').hidden || exporting || e.target.closest('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); playing ? stopPlayback() : startPlayback(); }
  else if (e.key === 's' || e.key === 'S') $('split').click();
  else if (e.key === 'Delete' || e.key === 'Backspace') $('delete').click();
});

// ---------- export settings ----------

$('aspect').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  settings.aspect = chip.dataset.value;
  for (const c of $('aspect').children) c.classList.toggle('active', c === chip);
  updateCropBox();
  updateSummary();
});
$('size').addEventListener('change', () => { settings.shortSide = Number($('size').value); updateSummary(); });
$('quality').addEventListener('change', () => { settings.quality = $('quality').value; updateSummary(); });
$('mute').addEventListener('change', () => { settings.mute = $('mute').checked; updateSummary(); });

// Show on the video which part the crop keeps.
function updateCropBox() {
  const box = $('crop-box');
  if (!video.videoWidth || settings.aspect === 'original') { box.hidden = true; return; }
  const { crop } = computeOutput(video.videoWidth, video.videoHeight, settings.aspect, 0);
  box.hidden = false;
  box.style.left = `${(crop.x / video.videoWidth) * 100}%`;
  box.style.top = `${(crop.y / video.videoHeight) * 100}%`;
  box.style.width = `${(crop.w / video.videoWidth) * 100}%`;
  box.style.height = `${(crop.h / video.videoHeight) * 100}%`;
}

// "1080×1920 · 0:12.4 · about 6 MB"
function updateSummary() {
  if (!video.videoWidth) return;
  const { width, height } = computeOutput(video.videoWidth, video.videoHeight, settings.aspect, settings.shortSide);
  const seconds = timeline.editedDuration;
  const bits = estimateBitrate(width, height, settings.quality) * 0.8 + (settings.mute ? 0 : 160_000);
  const mb = (bits * seconds) / 8 / 1e6;
  $('summary').textContent = `${width}×${height} · ${formatTime(seconds)} · about ${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

// ---------- export ----------

$('export').addEventListener('click', async () => {
  if (!currentFile || exporting) return;
  exporting = true;
  stopPlayback();
  const controls = document.querySelectorAll('button, select, input, .timeline');
  controls.forEach((c) => { c.disabled = true; c.style.pointerEvents = 'none'; });
  const progress = $('progress');
  progress.hidden = false;
  progress.value = 0;
  $('download').hidden = true;

  try {
    const blob = await exportMp4({
      file: currentFile,
      video,
      segments: timeline.segments.map((s) => ({ ...s })),
      ...settings,
      onProgress: (fraction, text) => {
        progress.value = fraction;
        setStatus(`${text} ${Math.round(fraction * 100)}%`);
      },
    });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const link = $('download');
    const baseName = currentFile.name.replace(/\.[^.]+$/, '');
    link.href = downloadUrl;
    link.download = `${baseName}-viveditor.mp4`;
    link.textContent = `⬇ Download (${(blob.size / 1e6).toFixed(1)} MB)`;
    link.hidden = false;
    setStatus('Done! Your video is ready.');
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message}`, true);
  } finally {
    exporting = false;
    controls.forEach((c) => { c.disabled = false; c.style.pointerEvents = ''; });
    $('delete').disabled = timeline.segments.length <= 1;
    progress.hidden = true;
  }
});
