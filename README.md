# VivEditor

A photo and video editor that runs **only in your browser**. Your files are never uploaded.

## Stage 2: video trimmer (`video.html`)

1. Open a video file (MP4, WebM, MOV…).
2. Move the **Start** and **End** sliders (or pause the video and press "Start/End = current position").
3. Press **Export MP4** and keep the tab visible until it says *Done!*.

### How it works

| Step | Browser feature | What it does |
| --- | --- | --- |
| Read the file | `URL.createObjectURL` | Lets the page read the file from your disk, with no upload |
| Pictures | `<video>` + `requestVideoFrameCallback` + `VideoEncoder` (WebCodecs) | Plays the chosen part and compresses each frame as H.264 |
| Sound | Web Audio `decodeAudioData` + `AudioEncoder` | Cuts the sound to the same part and compresses it (AAC, or Opus if AAC isn't available) |
| MP4 file | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT, in `lib/`) | Puts pictures and sound together in one `.mp4` |

Why WebCodecs and not ffmpeg.wasm? WebCodecs is built into the browser, so the page stays tiny and fast,
and it works on GitHub Pages. (The fast multi-thread ffmpeg.wasm needs special server headers that GitHub Pages can't send.)

Export runs at normal playback speed: a 1-minute clip takes about 1 minute.

Works in recent Chrome, Edge, Safari (17+) and Firefox (130+).

## Run it on your computer

Browsers block JavaScript modules opened straight from a file, so start a tiny local server in this folder:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

## Put it online (GitHub Pages)

Repository → **Settings** → **Pages** → *Deploy from a branch* → `main` / `(root)` → **Save**.
