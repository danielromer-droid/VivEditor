// video.js — the buttons and sliders of the video trimmer page.
import { exportMp4, browserCanExport } from './exporter.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const startInput = $('start');
const endInput = $('end');
let currentFile = null;
let downloadUrl = null;

// 0:07.5 style display
function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

if (!browserCanExport()) {
  $('support').textContent =
    'Heads up: this browser cannot export MP4 yet. Use a recent Chrome, Edge, Safari or Firefox.';
}

$('file').addEventListener('change', () => {
  const file = $('file').files[0];
  if (!file) return;
  currentFile = file;
  // A "blob URL" points to the file on your disk. Nothing is sent anywhere.
  video.src = URL.createObjectURL(file);
  $('download').hidden = true;
  $('status').textContent = '';
});

video.addEventListener('loadedmetadata', () => {
  const d = video.duration;
  for (const input of [startInput, endInput]) input.max = d.toFixed(1);
  startInput.value = 0;
  endInput.value = d.toFixed(1);
  updateLabels();
  $('step-trim').hidden = false;
  $('step-export').hidden = false;
});

video.addEventListener('error', () => {
  $('support').textContent = 'This browser cannot read that video file. Try an MP4 or WebM.';
});

function updateLabels() {
  const s = Number(startInput.value);
  const e = Number(endInput.value);
  $('start-label').textContent = formatTime(s);
  $('end-label').textContent = formatTime(e);
  $('length').textContent = formatTime(Math.max(0, e - s));
}

// Keep start before end, and show the picture where the slider is.
startInput.addEventListener('input', () => {
  if (Number(startInput.value) >= Number(endInput.value)) startInput.value = Number(endInput.value) - 0.1;
  video.currentTime = Number(startInput.value);
  updateLabels();
});
endInput.addEventListener('input', () => {
  if (Number(endInput.value) <= Number(startInput.value)) endInput.value = Number(startInput.value) + 0.1;
  video.currentTime = Number(endInput.value);
  updateLabels();
});

$('set-start').addEventListener('click', () => {
  startInput.value = Math.min(video.currentTime, Number(endInput.value) - 0.1).toFixed(1);
  updateLabels();
});
$('set-end').addEventListener('click', () => {
  endInput.value = Math.max(video.currentTime, Number(startInput.value) + 0.1).toFixed(1);
  updateLabels();
});

// Play only the chosen part.
let stopAtEnd = null;
$('preview').addEventListener('click', () => {
  video.currentTime = Number(startInput.value);
  video.play();
  if (stopAtEnd) video.removeEventListener('timeupdate', stopAtEnd);
  stopAtEnd = () => {
    if (video.currentTime >= Number(endInput.value)) {
      video.pause();
      video.removeEventListener('timeupdate', stopAtEnd);
    }
  };
  video.addEventListener('timeupdate', stopAtEnd);
});

$('export').addEventListener('click', async () => {
  if (!currentFile) return;
  const buttons = document.querySelectorAll('button, input');
  buttons.forEach((b) => (b.disabled = true));
  const progress = $('progress');
  progress.hidden = false;
  $('download').hidden = true;
  if (stopAtEnd) video.removeEventListener('timeupdate', stopAtEnd);

  try {
    const blob = await exportMp4({
      file: currentFile,
      video,
      start: Number(startInput.value),
      end: Number(endInput.value),
      onProgress: (fraction, text) => {
        progress.value = fraction;
        $('status').textContent = `${text} ${Math.round(fraction * 100)}%`;
      },
    });
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(blob);
    const link = $('download');
    const baseName = currentFile.name.replace(/\.[^.]+$/, '');
    link.href = downloadUrl;
    link.download = `${baseName}-trimmed.mp4`;
    link.textContent = `Download ${link.download} (${(blob.size / 1e6).toFixed(1)} MB)`;
    link.hidden = false;
    $('status').textContent = 'Done!';
  } catch (err) {
    console.error(err);
    $('status').textContent = `Export failed: ${err.message}`;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    progress.hidden = true;
  }
});
