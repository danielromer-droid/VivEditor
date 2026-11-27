# VivEditor handoff

*Last updated: 27 November 2026*

This page sums up where the project stands, so anyone (you, or a new helper) can pick it up without re-reading old conversations.

- **Live site:** https://danielromer-droid.github.io/VivEditor/
- **Code:** https://github.com/danielromer-droid/VivEditor (branch `main`)
- **User guide:** [README.md](README.md) explains every button and tool.

---

## 1. The goal

A photo and video editor that runs in the web browser, hosted for free on GitHub. The project has two parts:

1. **A miniPaint fork:** a copy of the open-source miniPaint editor (MIT license), rebranded as yours and put on GitHub Pages. **Not started yet.**
2. **VivEditor:** your own editor, built from scratch in stages. **This is the one that exists today.**

The original plan for VivEditor had four stages:

| Stage | What | Status |
| --- | --- | --- |
| 1 | Photo basics: crop, filters, text | ✅ Done, and went much further (see the photo editor below) |
| 2 | Video trimming and MP4 export | ✅ Done |
| 3 | Cartoon filter for photos and videos | ⏳ Not started |
| 4 | AI cartoon / anime style (for example AnimeGAN) in the browser | ⏳ Not started |

---

## 2. Design rules

These rules apply to every change.

1. **Nothing is ever uploaded.** Photos and videos stay on the person's device. All the work (editing, exporting, AI) happens inside the browser. The only things the site downloads are its own code and, for the AI tools, the AI model files.
2. **No build step.** The site is plain HTML, CSS and JavaScript files. GitHub Pages serves them exactly as they are in the repository. There is no npm, no bundler and no server.
3. **It must work on GitHub Pages.** GitHub Pages can't send special server headers. That's why video export uses **WebCodecs** (built into the browser) and not ffmpeg.wasm, whose fast version needs those headers.
4. **Outside code is pinned and checked.** Small libraries are copied into `lib/` with their licenses. ONNX Runtime Web is loaded from jsDelivr at a fixed version (1.22.0). AI models come from Hugging Face at a fixed version, are checked with a SHA-256 fingerprint, and are kept in the browser's cache after the first download.
5. **Phones count.** Every page has a phone layout. Big photos are reduced to 4096 pixels on their longest side (2560 on phones) to stay fast. Phones get a "Share / Save to Photos" button.
6. **Non-destructive editing.** Adjustment layers and masks never change the original pixels.
7. **Simple explanations.** The owner is learning as the project grows. Docs, pull requests and messages use plain language.
8. **Changes go through pull requests** that the owner reviews and merges. Merging to `main` updates the live site within a minute or two.

---

## 3. Architecture

### Pages

| File | What it is |
| --- | --- |
| `index.html` | Home page with links to the two editors |
| `photo.html` + `photo.css` | Photo editor |
| `video.html` | Video editor |
| `style.css` | Shared dark look used by all pages |

### Video editor

| File | Job |
| --- | --- |
| `video.js` | Buttons and export settings |
| `timeline.js` | Thumbnail strip, trim handles, split and delete parts |
| `exporter.js` | Makes the MP4 file |

How export works, step by step:

1. The file is opened with `URL.createObjectURL`, so it's read from the disk and never uploaded.
2. Each kept part plays in a hidden `<video>`. Each frame is drawn on a canvas (cropped and resized), then compressed to H.264 by WebCodecs' `VideoEncoder`.
3. The sound is decoded with Web Audio and compressed by `AudioEncoder` (AAC, or Opus if AAC isn't available).
4. `lib/mp4-muxer.mjs` (mp4-muxer 5.2.2, MIT) joins picture and sound into one `.mp4`.

Export runs at normal playback speed (a 1-minute edit takes about 1 minute), and the tab must stay open.

**Ready for stage 3:** `exportMp4()` in `exporter.js` takes a `drawFrame` option that is called for every frame. A cartoon filter for video can plug in right there.

### Photo editor

Everything is drawn with the browser's 2D canvas (no WebGL).

| File | Job |
| --- | --- |
| `photo/photo.js` | The page: panels, buttons, keyboard shortcuts, export |
| `photo/doc.js` | The document: layers and undo/redo |
| `photo/render.js` | Stacks the layers with blend modes, opacity, masks and clipping |
| `photo/adjust.js` | Color math for the adjustment layers |
| `photo/curves.js` | The Curves editor |
| `photo/tools.js` | Move, crop, brush, eraser, text, clone stamp, spot healing and more |
| `photo/selection.js` | Rectangle, ellipse, lasso, magic wand |
| `photo/heal.js` | Healing (fills an area with nearby texture) |
| `photo/formats.js` | TIFF, PDF and PSD export (PSD uses `lib/ag-psd.min.js`, MIT, loaded only when needed) |
| `photo/ai.js` | AI tools |

AI tools (in `photo/ai.js`) run with ONNX Runtime Web:

| Tool | Model | Size |
| --- | --- | --- |
| AI Select (tap an object) | SlimSAM | about 14 MB |
| Remove background | MODNet | about 7 MB |
| AI Remove (erase an object) | MI-GAN | about 28 MB |

---

## 4. Completed milestones

| Date | What | Pull request |
| --- | --- | --- |
| 20 Nov 2026 | First video trimmer with MP4 export (WebCodecs), named VivEditor, put on GitHub and GitHub Pages | pushed straight to `main` (empty repo) |
| 20 Nov 2026 | Video editor upgrade: dark layout, thumbnail timeline, several cuts, export options (shape, size, quality, mute) | [#1](https://github.com/danielromer-droid/VivEditor/pull/1) |
| 20 Nov 2026 | Photo editor: layers, 16 blend modes, opacity, move/resize/rotate, crop, undo; 10 adjustment layers; brush, eraser, text; selections; masks and clipping; PNG/JPEG/WebP export | [#2](https://github.com/danielromer-droid/VivEditor/pull/2) |
| 21 Nov 2026 | Clone stamp, spot healing, Heal a selection; TIFF, PDF and PSD (with layers) export | [#3](https://github.com/danielromer-droid/VivEditor/pull/3) |
| 21 Nov 2026 | AI tools: AI Select, Remove background, AI Remove | [#4](https://github.com/danielromer-droid/VivEditor/pull/4) |

All four pull requests are merged and live.

---

## 5. Open tasks

### Waiting on you

- **Choose how to make VivEditor a Windows app.** On 21 Nov you asked whether VivEditor could be a program for a Windows PC. Two options were offered, and the answer is still pending:
  1. **Installable web app** (recommended): you click *Install* in Edge or Chrome, VivEditor gets its own icon and window, works offline, and updates on its own. About one small pull request.
  2. **Real Windows program** (.exe built with Electron): about 100 MB, a new installer for each update, and an "unknown publisher" warning unless you buy a code-signing certificate.

  Reply with your choice and the work can start.

- **Test what couldn't be tested from the cloud:**
  - 🪄 **AI Select with the real SlimSAM model.** It was only tested with a stand-in model, because Hugging Face was blocked from the test computer.
  - **iPhone and Safari** for both editors (only tested in a test browser at phone size).
  - **Opening an exported PSD in Photoshop** (it was only checked with another PSD reader).

### Next stages

- **Stage 3: cartoon filter** for photos and videos. For video, use the `drawFrame` hook in `exporter.js`. For photos, it could be a new adjustment layer or filter in the photo editor.
- **Stage 4: AI anime style** (for example AnimeGAN) running in the browser, reusing the ONNX Runtime setup and model cache from `photo/ai.js`.
- **miniPaint fork:** fork miniPaint, rebrand it, and put it on GitHub Pages. Not created yet.

### Ideas mentioned but not planned yet

- **Puppet Warp and removing cast shadows** were judged hard and left for much later.
- **CMYK** isn't really possible in a browser (browsers only work in RGB). Only needed for professional printing.

### Known limits

- Video export runs at playback speed, and the tab must stay visible while it runs.
- AI tools are slower on phones, and the first use of each tool waits for its model to download.
- The cloud helper can't open `github.io` pages, so checks on the live site need you.
