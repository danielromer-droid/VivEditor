// exporter.js — turns your edit into an MP4 file, entirely in the browser.
//
// How it works, in plain words:
//   1. Pictures: for each part you kept, we play the video (muted) from its start
//      to its end. Each time the browser shows a new frame, we draw it on a hidden
//      canvas (cropped and resized) and give it to the VideoEncoder (WebCodecs),
//      which compresses it as H.264.
//   2. Sound: we decode the audio track with the Web Audio API, take the same parts,
//      glue them together and give them to the AudioEncoder (AAC, or Opus).
//   3. Box: mp4-muxer puts the compressed pictures and sound together in one .mp4.
//
// Nothing is uploaded: the file is read from disk and the result stays in memory
// until you download it.
//
// The `drawFrame` option lets a later stage (cartoon filter!) change each picture
// before it is encoded.

import { Muxer, ArrayBufferTarget } from './lib/mp4-muxer.mjs';

const FRAME_DURATION_US = Math.round(1e6 / 30);

export function browserCanExport() {
  return 'VideoEncoder' in window &&
    'VideoFrame' in window &&
    'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}

// Bits per pixel per second for each quality level.
const QUALITY = { high: 7, medium: 4, low: 2 };

export function estimateBitrate(width, height, quality) {
  return Math.round(Math.min(25_000_000, Math.max(500_000, width * height * (QUALITY[quality] ?? 4))));
}

/**
 * Works out which rectangle of the original video to keep (crop) and
 * how big the final video will be.
 * @param {number} vw, vh   original size
 * @param {string} aspect   'original' | '1:1' | '9:16' | '4:5' | '16:9'
 * @param {number} shortSide  0 = keep size, else e.g. 720 for 720p
 */
export function computeOutput(vw, vh, aspect, shortSide) {
  let ratio = vw / vh;
  if (aspect !== 'original') {
    const [a, b] = aspect.split(':').map(Number);
    ratio = a / b;
  }
  // Largest centred rectangle with that shape.
  let cw = vw;
  let ch = vh;
  if (vw / vh > ratio) cw = vh * ratio;
  else ch = vw / ratio;
  const crop = { x: (vw - cw) / 2, y: (vh - ch) / 2, w: cw, h: ch };

  // Shrink (never enlarge) so the short side matches the chosen size.
  const scale = shortSide ? Math.min(1, shortSide / Math.min(cw, ch)) : 1;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2); // H.264 needs even sizes
  return { crop, width: even(cw * scale), height: even(ch * scale) };
}

// Try H.264 profiles from best to most basic, and keep the first one this browser accepts.
async function pickVideoConfig(width, height, bitrate) {
  const codecs = ['avc1.640033', 'avc1.640028', 'avc1.4d0028', 'avc1.42002a', 'avc1.42001f'];
  for (const codec of codecs) {
    const config = { codec, width, height, bitrate, framerate: 30, avc: { format: 'avc' } };
    try {
      const { supported } = await VideoEncoder.isConfigSupported(config);
      if (supported) return config;
    } catch { /* try the next one */ }
  }
  return null;
}

// Decode the audio track. Returns null if the video has no sound (or the browser can't read it).
async function decodeAudio(file, sampleRate) {
  try {
    const bytes = await file.arrayBuffer();
    const ctx = new OfflineAudioContext(2, 1, sampleRate);
    return await ctx.decodeAudioData(bytes);
  } catch {
    return null;
  }
}

async function pickAudioConfig(channels) {
  if (!('AudioEncoder' in window)) return null;
  // AAC is the usual sound format inside MP4. Opus is a fallback for browsers without AAC.
  const options = [
    { muxCodec: 'aac', sampleRate: 48000, config: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: channels, bitrate: 160_000 } },
    { muxCodec: 'aac', sampleRate: 44100, config: { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: channels, bitrate: 160_000 } },
    { muxCodec: 'opus', sampleRate: 48000, config: { codec: 'opus', sampleRate: 48000, numberOfChannels: channels, bitrate: 128_000 } },
  ];
  for (const option of options) {
    try {
      const { supported } = await AudioEncoder.isConfigSupported(option.config);
      if (supported) return option;
    } catch { /* try the next one */ }
  }
  return null;
}

/**
 * @param {object} p
 * @param {File} p.file                 the original video file
 * @param {HTMLVideoElement} p.video    a video element with that file loaded
 * @param {{start:number,end:number}[]} p.segments  the parts to keep, in order (seconds)
 * @param {string} [p.aspect]           see computeOutput
 * @param {number} [p.shortSide]        see computeOutput
 * @param {'high'|'medium'|'low'} [p.quality]
 * @param {boolean} [p.mute]            true = no sound in the MP4
 * @param {(fraction:number, text:string)=>void} [p.onProgress]
 * @param {(ctx, video, crop, width, height)=>void} [p.drawFrame]  custom drawing (filters)
 * @returns {Promise<Blob>} the MP4 file
 */
export async function exportMp4({
  file, video, segments, aspect = 'original', shortSide = 0, quality = 'medium', mute = false,
  onProgress = () => {}, drawFrame,
}) {
  const parts = segments.filter((s) => s.end - s.start > 0);
  const total = parts.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (!(total > 0)) throw new Error('There is nothing to export.');

  const { crop, width, height } = computeOutput(video.videoWidth, video.videoHeight, aspect, shortSide);
  const bitrate = estimateBitrate(width, height, quality);
  const videoConfig = await pickVideoConfig(width, height, bitrate);
  if (!videoConfig) throw new Error(`This browser cannot make H.264 video at ${width}×${height}. Try a smaller size.`);

  // ---- Sound: decide if (and how) we can include it ----
  let audioOption = null;
  let audio = null;
  if (!mute) {
    onProgress(0, 'Reading the sound…');
    audio = await decodeAudio(file, 48000);
    if (audio) {
      audioOption = await pickAudioConfig(Math.min(2, audio.numberOfChannels));
      // If only 44.1 kHz AAC works, decode again at that rate.
      if (audioOption && audioOption.sampleRate !== 48000) {
        audio = await decodeAudio(file, audioOption.sampleRate);
        if (!audio) audioOption = null;
      }
    }
  }

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width, height },
    audio: audioOption ? {
      codec: audioOption.muxCodec,
      numberOfChannels: audioOption.config.numberOfChannels,
      sampleRate: audioOption.sampleRate,
    } : undefined,
    fastStart: 'in-memory', // index at the start, so the MP4 plays right away everywhere
    firstTimestampBehavior: 'offset',
  });

  let encodeError = null;
  const fail = (e) => { encodeError = encodeError || e; };

  if (audioOption) {
    onProgress(0, 'Encoding the sound…');
    await encodeAudio(audio, audioOption, parts, muxer, fail);
    audio = null; // free memory
  }

  // ---- Pictures ----
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      try { muxer.addVideoChunk(chunk, meta); } catch (e) { fail(e); }
    },
    error: fail,
  });
  videoEncoder.configure(videoConfig);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  let offset = 0; // where the current part begins in the finished video (seconds)
  let frameIndex = 0;
  const message = parts.length > 1
    ? (n) => `Encoding part ${n} of ${parts.length}… keep this tab open.`
    : () => 'Encoding… keep this tab open.';

  for (let n = 0; n < parts.length; n++) {
    const part = parts[n];
    let firstOfPart = true;
    await recordFrames({
      video, start: part.start, end: part.end,
      onFrame: (mediaTime) => {
        if (encodeError) throw encodeError;
        if (drawFrame) drawFrame(ctx, video, crop, width, height);
        else ctx.drawImage(video, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
        const local = mediaTime - part.start;
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((offset + local) * 1e6),
          duration: FRAME_DURATION_US, // a guess; the MP4 uses the real gaps between frames
        });
        // A "keyframe" every ~2 s and at each cut keeps the file easy to scrub through.
        videoEncoder.encode(frame, { keyFrame: firstOfPart || frameIndex % 60 === 0 });
        frame.close();
        firstOfPart = false;
        frameIndex++;
        onProgress((offset + local) / total, message(n + 1));
      },
    });
    offset += part.end - part.start;
  }

  onProgress(1, 'Finishing the file…');
  await videoEncoder.flush();
  videoEncoder.close();
  if (encodeError) throw encodeError;
  if (frameIndex === 0) throw new Error('No pictures could be read from the video.');
  muxer.finalize();

  return new Blob([target.buffer], { type: 'video/mp4' });
}

async function encodeAudio(buffer, option, parts, muxer, onError) {
  const { sampleRate } = option;
  const channels = option.config.numberOfChannels;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      try { muxer.addAudioChunk(chunk, meta); } catch (e) { onError(e); }
    },
    error: onError,
  });
  encoder.configure(option.config);

  const source = [];
  for (let c = 0; c < channels; c++) source.push(buffer.getChannelData(c));

  let written = 0; // samples already sent, so the parts follow each other without gaps
  const block = 4096;
  for (const part of parts) {
    const first = Math.max(0, Math.floor(part.start * sampleRate));
    const last = Math.min(buffer.length, Math.floor(part.end * sampleRate));
    for (let pos = first; pos < last; pos += block) {
      const frames = Math.min(block, last - pos);
      // "planar" = all samples of channel 1, then all samples of channel 2
      const data = new Float32Array(frames * channels);
      for (let c = 0; c < channels; c++) data.set(source[c].subarray(pos, pos + frames), c * frames);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: frames,
        numberOfChannels: channels,
        timestamp: Math.round((written / sampleRate) * 1e6),
        data,
      });
      encoder.encode(audioData);
      audioData.close();
      written += frames;
    }
  }
  await encoder.flush();
  encoder.close();
}

// Plays the video from start to end and calls onFrame for every new picture.
function recordFrames({ video, start, end, onFrame }) {
  return new Promise((resolve, reject) => {
    const wasMuted = video.muted;
    let lastTime = -1;
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      video.pause();
      video.muted = wasMuted;
      video.removeEventListener('ended', onEnded);
      err ? reject(err) : resolve();
    };
    const onEnded = () => finish();

    const onVideoFrame = (_now, meta) => {
      if (done) return;
      const t = meta.mediaTime;
      if (t >= end) return finish();
      if (t >= start - 0.001 && t > lastTime) {
        try {
          onFrame(Math.max(t, start));
        } catch (e) {
          return finish(e);
        }
        lastTime = t;
      }
      video.requestVideoFrameCallback(onVideoFrame);
    };

    video.addEventListener('ended', onEnded);
    video.pause();
    video.muted = true;
    video.addEventListener('seeked', () => {
      video.requestVideoFrameCallback(onVideoFrame);
      video.play().catch(finish);
    }, { once: true });
    video.currentTime = start;
  });
}
