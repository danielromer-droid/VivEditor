# VivEditor

A photo and video editor that runs **only in your browser**. Your files are never uploaded.

**Try it:** https://danielromer-droid.github.io/VivEditor/

## Photo editor (`photo.html`)

Open a photo (or start with a blank picture), then:

- **Layers:** add photos (+ Photo, drag and drop or paste) and empty layers. Each layer has a **blend mode** (Multiply, Screen, Overlay, Soft light…) and an **opacity**. Show/hide with the eye, drag order with ↑ ↓, double-click to rename.
- **Move tool (V):** drag to move, corners to resize, round handle to rotate. Exact numbers, flip and 90° turns are in the Properties panel.
- **Crop (C):** drag the area to keep, then *Apply crop* (or Enter).
- **Adjustment layers** (*+ Adjustment…*): Brightness/Contrast, Levels, Curves, Hue/Saturation, Color Balance, Black & White, Clarity, Dehaze, Grain, Invert. They change everything below them and never touch the original pixels. With a selection, the adjustment only affects the selected area.
- **Brush (B) and Eraser (E):** size, hardness, opacity, color. `[` and `]` change the size.
- **Text (T):** tap the picture, then type in the Properties panel (font, size, color, bold, italic, alignment).
- **Selections:** Rectangle (M), Ellipse, Lasso (L), Magic wand (W). Shift adds, Alt subtracts. Then Fill, Delete, Invert or turn the selection into a mask. Brushes only paint inside the selection.
- **Masks:** *Mask* adds a layer mask (from the selection if there is one). Tap the mask thumbnail and paint: *Hide* paints black, *Reveal* paints white.
- **Clip:** shows a layer only where the layer below has pixels (great for putting a photo inside text).
- **Undo/Redo** (Ctrl+Z / Ctrl+Shift+Z), zoom with + − 0, Ctrl + scroll or two fingers, Hand tool (H or hold Space).
- **Export:** PNG, JPEG or WebP. On a phone, *Share / Save to Photos*.

Big photos are reduced to 4096 pixels (2560 on phones) on their longest side to stay fast.

Code map: `photo/doc.js` (layers, undo), `photo/render.js` (stacking the layers), `photo/adjust.js` (color adjustments), `photo/tools.js` (tools), `photo/selection.js`, `photo/curves.js`, `photo/photo.js` (the page).

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
