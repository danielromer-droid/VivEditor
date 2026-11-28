# AGENTS.md — VivEditor (photo & video editor)

Instructions for any AI coding agent (Claude, Antigravity, Codex, Copilot…) working in this repo.

## What this project is
The owner's own Photoshop-style photo and video editor. It runs **only in the browser**, and files are never uploaded. Live at https://danielromer-droid.github.io/VivEditor/
Owner's goals: a full photo editor, video editing, and a "cartoon" effect for personal photos and videos.

## Setup
- **No build step.** Hosted on **GitHub Pages** from `main` (`.nojekyll`). A push to `main` updates the live site.
- `index.html`: start page. `photo.html` + `photo.css` + `photo/`: photo editor (layers, adjustments, brushes, selections, masks, AI tools). `video.html` + `video.js` + `timeline.js` + `exporter.js`: video editor. `lib/`: third-party libraries. `style.css`: shared styles.
- AI tools (e.g. AI Select with SlimSAM) run on the device. Only the model files are downloaded the first time (from Hugging Face) and kept in the browser.
- Full feature list: `README.md`. Update it when you add a feature.

## Project rules
- **Privacy:** photos and videos never leave the device. No uploads, no server-side processing.
- Free, open-source libraries only. Keep their licences and credits.
- Must work on a phone as well as a computer (touch and mouse), including keyboard shortcuts where they exist.

## Rules for all of Daniel's projects (the same in every repo)
- **Free only.** Use free plans and free services. Ask the owner before adding anything paid.
- **No secrets in the repo.** API keys, passwords and tokens go in Cloudflare or GitHub secrets.
- **Keep the owner's private email address out** of the code and the website.
- **Don't break links.** Keep existing URLs, page titles and sitemaps working (Google ranking).
- **`main` is live.** In most repos a push to `main` publishes the site or builds a new app release. Only push work that builds and has been checked.
- **Explain changes simply.** Give a short, plain-language summary of what changed and how to check it.
- **Keep this file current** when the setup changes. Claude reads it through `CLAUDE.md`. Antigravity, Codex and Copilot read `AGENTS.md` directly.
