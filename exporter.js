// exporter.js — turns one part of a video into an MP4 file, entirely in the browser.
//
// How it works, in plain words:
//   1. Pictures: we play the video (muted) from "start" to "end". Each time the
//      browser shows a new frame, we copy it onto a hidden canvas and give it to
//      the VideoEncoder (WebCodecs), which compresses it as H.264.
//   2. Sound: we decode the whole audio track with the Web Audio API, cut out the
//      samples between "start" and "end", and give them to the AudioEncoder (AAC).
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

// Try H.264 profiles from best to most basic, and keep the first one this browser accepts.
async function pickVideoConfig(width, height) {
  const bitrate = Math.round(Math.min(12_000_000, Math.max(1_500_000, width * height * 4)));
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
 * @param {File} p.file            the original video file
 * @param {HTMLVideoElement} p.video  a video element with that file loaded
 * @param {number} p.start         seconds
 * @param {number} p.end           seconds
 * @param {(fraction:number, text:string)=>void} [p.onProgress]
 * @param {(ctx:CanvasRenderingContext2D, video:HTMLVideoElement, w:number, h:number)=>void} [p.drawFrame]
 * @returns {Promise<Blob>} the MP4 file
 */
export async function exportMp4({ file, video, start, end, onProgress = () => {}, drawFrame }) {
  const duration = end - start;
  if (!(duration > 0)) throw new Error('The end must be after the start.');

  // H.264 needs even width and height.
  const width = video.videoWidth & ~1;
  const height = video.videoHeight & ~1;

  const videoConfig = await pickVideoConfig(width, height);
  if (!videoConfig) throw new Error(`This browser cannot encode H.264 video at ${width}×${height}.`);

  onProgress(0, 'Reading the sound…');
  // Ask for audio at 48 kHz first; if only 44.1 kHz AAC works we decode again at that rate.
  let audioOption = null;
  let audio = await decodeAudio(file, 48000);
  if (audio) {
    const channels = Math.min(2, audio.numberOfChannels);
    audioOption = await pickAudioConfig(channels);
    if (audioOption && audioOption.sampleRate !== 48000) {
      audio = await decodeAudio(file, audioOption.sampleRate);
      if (!audio) audioOption = null;
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
    fastStart: 'in-memory', // puts the index at the start so the MP4 plays right away everywhere
    firstTimestampBehavior: 'offset',
  });

  let encodeError = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      try { muxer.addVideoChunk(chunk, meta); } catch (e) { encodeError = e; }
    },
    error: (e) => { encodeError = e; },
  });
  videoEncoder.configure(videoConfig);

  // ---- Sound ----
  if (audioOption) {
    onProgress(0, 'Encoding the sound…');
    await encodeAudio(audio, audioOption, start, end, muxer, (e) => { encodeError = e; });
  }

  // ---- Pictures ----
  onProgress(0, 'Encoding the pictures… keep this tab open and visible.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  await recordFrames({
    video, start, end,
    onFrame: (mediaTime, frameIndex) => {
      if (encodeError) throw encodeError;
      if (drawFrame) drawFrame(ctx, video, width, height);
      else ctx.drawImage(video, 0, 0, width, height);
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((mediaTime - start) * 1e6),
        duration: FRAME_DURATION_US, // a guess; the MP4 uses the real gaps between frames
      });
      videoEncoder.encode(frame, { keyFrame: frameIndex % 60 === 0 }); // a "keyframe" every ~2 s
      frame.close();
      onProgress((mediaTime - start) / duration, 'Encoding the pictures… keep this tab open and visible.');
    },
  });

  onProgress(1, 'Finishing the file…');
  await videoEncoder.flush();
  videoEncoder.close();
  if (encodeError) throw encodeError;
  muxer.finalize();

  return new Blob([target.buffer], { type: 'video/mp4' });
}

async function encodeAudio(buffer, option, start, end, muxer, onError) {
  const { sampleRate } = option;
  const channels = option.config.numberOfChannels;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      try { muxer.addAudioChunk(chunk, meta); } catch (e) { onError(e); }
    },
    error: onError,
  });
  encoder.configure(option.config);

  const first = Math.max(0, Math.floor(start * sampleRate));
  const last = Math.min(buffer.length, Math.floor(end * sampleRate));
  const source = [];
  for (let c = 0; c < channels; c++) source.push(buffer.getChannelData(c));

  const block = 4096;
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
      timestamp: Math.round(((pos - first) / sampleRate) * 1e6),
      data,
    });
    encoder.encode(audioData);
    audioData.close();
  }
  await encoder.flush();
  encoder.close();
}

// Plays the video from start to end and calls onFrame for every new picture.
function recordFrames({ video, start, end, onFrame }) {
  return new Promise((resolve, reject) => {
    const wasMuted = video.muted;
    let lastTime = -1;
    let index = 0;
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
          onFrame(Math.max(t, start), index++);
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
    video.currentTime = start;
    video.addEventListener('seeked', () => {
      video.requestVideoFrameCallback(onVideoFrame);
      video.play().catch(finish);
    }, { once: true });
  });
}
