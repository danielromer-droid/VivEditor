# VivEditor

A photo and video editor that runs **only in your browser**. Your files are never uploaded.

**Try it:** https://danielromer-droid.github.io/VivEditor/

## Video editor (`video.html`)

1. **Open a video** (button at the top, or drag and drop the file).
2. **Trim:** drag the yellow handles at both ends of the timeline.
3. **Cut out a part:** move the playhead, press **Split** (or `S`), tap the part you don't want and press **Delete part**. Do it as many times as you like. **Reset** undoes all cuts.
4. **Play** (or space bar) plays your edit, skipping the parts you cut.
5. In the **Export** panel choose:
   - **Shape:** Original, Square 1:1, Vertical 9:16 (Stories, Reels, TikTok), Portrait 4:5 or Wide 16:9. A white frame on the video shows what will be kept.
   - **Size:** same as the video, 1080p, 720p or 480p.
   - **Quality:** high, medium or low (smaller file).
   - **Remove the sound** if you want a silent video.
6. Press **Export MP4** and keep the tab open until it says *Done!*, then **Download**.

### How it works

| Step | Browser feature | What it does |
| --- | --- | --- |
| Read the file | `URL.createObjectURL` | Lets the page read the file from your disk, with no upload |
| Pictures | `<video>` + `requestVideoFrameCallback` + canvas + `VideoEncoder` (WebCodecs) | Plays each kept part, crops/resizes each frame on a canvas, and compresses it as H.264 |
| Sound | Web Audio `decodeAudioData` + `AudioEncoder` | Takes the sound of the same parts, joined together, and compresses it (AAC, or Opus if AAC isn't available) |
| MP4 file | [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) (MIT, in `lib/`) | Puts pictures and sound together in one `.mp4` |

Why WebCodecs and not ffmpeg.wasm? WebCodecs is built into the browser, so the page stays tiny and fast,
and it works on GitHub Pages. (The fast multi-thread ffmpeg.wasm needs special server headers that GitHub Pages can't send.)

Export runs at normal playback speed: a 1-minute edit takes about 1 minute.

Code map: `video.js` (buttons and settings), `timeline.js` (thumbnails, handles, cuts), `exporter.js` (making the MP4).

Works in recent Chrome, Edge, Safari (17+) and Firefox (130+).

## Run it on your computer

Browsers block JavaScript modules opened straight from a file, so start a tiny local server in this folder:

```
python3 -m http.server 8000
```

then open http://localhost:8000.

## Put it online (GitHub Pages)

Repository → **Settings** → **Pages** → *Deploy from a branch* → `main` / `(root)` → **Save**.
