# Image Deduper

A desktop app (built on **kempo-app** / Electron) that finds duplicate images even when
they have been **cropped, rotated, scaled, re-filtered/toned, or watermarked**.

No Python, no venv, no cbird. The heavy lifting runs on a native ONNX neural model.

[Full documentation →](docs/index.html)

## How it works — a 3-tier hybrid engine

| Tier | Tech | Catches | Cost |
|------|------|---------|------|
| 1. Perceptual hash | `sharp` + 32×32 DCT pHash (8 dihedral orientations) | exact dupes, rescales, recompression, 90° rotations & mirrors | trivial |
| 2. Neural embeddings | DINOv2 via `@huggingface/transformers` (native `onnxruntime-node`, GPU→CPU) | **crop, arbitrary rotation, scale, filters/tone, watermark** | one inference per image |
| 3. Geometric verification | ORB + RANSAC homography via `@techstark/opencv-js` | confirms true geometric overlap on borderline pairs | only borderline pairs |

Each tier has its own enable toggle and confidence threshold (left pane, **Detection
Algorithms**) — a pair links into a duplicate set if *any* enabled tier clears its
threshold.

## Reference vs. Search images

Sources are split into two roles:

- **Reference** — known-good images you trust, never compared to each other.
- **Search** — the images being checked against the references (and, with no
  references at all, against each other — the simple "find dupes in this folder"
  case).

Because references are never compared to one another, two different references can
never end up merged into the same duplicate group — even if both happen to match the
same ambiguous search image, only the closer match keeps it.

## Persistent cache (no re-scanning)

Results are cached in SQLite (`better-sqlite3`, via kempo-app's DB, stored under the app's
userData dir) so re-scans only do *new* work:

- **`images`** — features (pHash + neural embedding) keyed by **content hash** (SHA-256 of the
  bytes). Because identity is the content, a **rename or move is free** — the features are reused.
- **`paths`** — `path → {size, mtime, hash}`, so unchanged files skip re-hashing entirely.
- **`orbcache`** — the expensive geometric scores, keyed by the sorted **hash pair**.
- **`excluded_pairs`** — hash pairs explicitly marked **Not Duplicates**, so they (and
  anything transitively linked to them) never re-group on a later scan.

Adding one image to a scanned folder computes features for just that image and only compares it
against the others; every prior comparison is loaded from cache. The results header shows e.g.
`12 files · 12 unique · features: 1 new / 11 cached · geometry: 4 new / 53 cached`. A **Clear
cache** button resets it.

## Auto Delete

Picks the image to keep per duplicate set — highest resolution first, ties broken by
most-lossless format, then smallest file size, then filename — and asks to delete the
rest. Filenames containing "screenshot" (any case) are deprioritized by default, since
a screenshot is often higher-resolution than the original purely because of the
capturing device, not because it's a better copy to keep (toggleable in Settings).

## Run

```sh
npm install
npm run dev       # Electron + DevTools + CDP on port 9222
# or
npm start
```

On the **first** scan with neural matching enabled, the DINOv2 model (~tens of MB) is
downloaded from the Hugging Face hub and cached. `better-sqlite3` v12 ships N-API prebuilds that
load in Electron as-is — no native rebuild step needed.

## Build

```sh
npm run package   # dist/win-unpacked/ — runnable folder, no installer
npm run make      # dist/*.exe — real NSIS installer wizard (Start Menu + Desktop shortcut)
```

Host OS/arch only, no cross-compiling. See [kempo-app](https://github.com/dustinpoissant/kempo-app)'s
docs for how packaging works under the hood.

## UI

Three resizable columns (kempo-ui `<k-split>` ×2, sizes persisted via `persistent-id`):

1. **Left** — Reference/Search source cards, detection tiers + thresholds, Settings, Start Scan.
2. **Middle** — list of duplicate sets, each showing a thumbnail, member count and per-tier scores.
3. **Right** — the selected set: every image with dimensions/size/path, a tile-size
   picker, and Open / Reveal / Trash / Compare / Not Duplicates / Auto Delete actions.

## Project layout

```
package.json          kempo-app config + deps
app.js                 renderer: registers kempo-ui components
shell.html             full-height app frame
theme.css              accent overrides
pages/index.html       <k-context>s wrapping <id-app>
components/             web components (one per file, PascalCase, <id-*> tags)
  App.js                orchestrator: scan pipeline + results, owns engine state
  Controls.js            left pane: sources, detection tiers, settings
  Results.js             middle pane: duplicate-set list
  Detail.js               right pane: images of the selected set + actions
  Dupe.js                 one duplicate-set row in Results
  ImageCard.js            one image tile in Detail
  Scores.js               per-tier % score widget
  SourceCard.js / SourceItem.js   Reference/Search import cards
  ToggleSlider.js / SliderInput.js  detection-tier and settings sliders
  CompareViewer.js         fullscreen wipe-compare overlay
lib/
  engine.js               clustering, caching, ORB matcher, thumbnails (renderer side)
  api.js                  proxy over window.api
  contexts.js             getConfig/getUI — locate the k-context elements
  styles.js               shared Lit styles
api/                     main-process functions exposed as window.api.*
  selectDirectories.js / selectImages.js   native pickers
  scanImages.js           recursive image walk
  fileIdentities.js       content-hash resolution
  initEngine.js           load the model (GPU→CPU)
  embedImages.js          pHash + embedding per batch
  grayBuffer.js           grayscale buffer for ORB
  thumbnail.js            oriented preview data URLs
  fileAction.js           open / reveal / trash
docs/                    project docs site (kempo-css via CDN)
```
