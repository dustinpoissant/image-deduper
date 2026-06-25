# Image Duplicate Detector

A desktop app (built on **kempo-app** / Electron) that finds duplicate images even when
they have been **cropped, rotated, scaled, re-filtered/toned, or watermarked**.

No Python, no venv, no cbird. The heavy lifting runs on a native ONNX neural model.

## How it works — a 3-tier hybrid engine

| Tier | Tech | Catches | Cost |
|------|------|---------|------|
| 1. Perceptual hash | `sharp` + 32×32 DCT pHash (8 dihedral orientations) | exact dupes, rescales, recompression, 90° rotations & mirrors | trivial |
| 2. Neural embeddings | DINOv2 via `@huggingface/transformers` (native `onnxruntime-node`, GPU→CPU) | **crop, arbitrary rotation, scale, filters/tone, watermark** | one inference per image |
| 3. Geometric verification | ORB + RANSAC homography via `@techstark/opencv-js` | confirms true geometric overlap on borderline pairs | only borderline pairs |

Each image is embedded once (O(n)); pair similarity is a cheap cosine (sparse O(n²)).
ORB only runs on the small set of *borderline* candidate pairs to refine confidence.

The **Confidence** slider is a live threshold — after a scan completes, dragging it
re-clusters instantly with no recomputation.

## Persistent cache (no re-scanning)

Results are cached in SQLite (`better-sqlite3`, via kempo-app's DB, stored under the app's
userData dir) so re-scans only do *new* work:

- **`images`** — features (pHash + neural embedding) keyed by **content hash** (SHA-256 of the
  bytes). Because identity is the content, a **rename or move is free** — the features are reused.
- **`paths`** — `path → {size, mtime, hash}`, so unchanged files skip re-hashing entirely.
- **`orbcache`** — the expensive geometric scores, keyed by the sorted **hash pair**.

Adding one image to a scanned folder computes features for just that image and only compares it
against the others; every prior comparison is loaded from cache. The results header shows e.g.
`12 files · 12 unique · features: 1 new / 11 cached · geometry: 4 new / 53 cached`. A **Clear
cache** link resets it.

## Run

```sh
npm install
npm run dev     # Electron + DevTools
# or
npm start
```

On the **first** scan with neural matching enabled, the DINOv2 model (~tens of MB) is
downloaded from the Hugging Face hub and cached. `better-sqlite3` v12 ships N-API prebuilds that
load in Electron as-is — no native rebuild step needed.

## UI

Three resizable columns (kempo-ui `<k-split>` ×2, sizes persisted via `persistent-id`):

1. **Left (25%)** — pick folders, choose detection tiers + GPU, set confidence, Start Scan.
2. **Middle (25%)** — list of duplicate sets, each showing a preview, count and best-match %.
3. **Right (50%)** — the selected set: every image with dimensions/size/path and
   Open / Reveal / Trash actions.

## Project layout

```
package.json        kempo-app config + deps
app.js              renderer: registers kempo-ui components
shell.html          full-height app frame
theme.css           accent overrides
pages/index.html    the whole 3-column UI + orchestration
src/engine.js       the detection engine (pHash + embeddings + ORB)
api/                main-process functions exposed as window.api.*
  selectDirectories.js  native folder picker
  scanImages.js         recursive image walk
  initEngine.js         load the model (GPU→CPU)
  embedImages.js        pHash + embedding per batch
  deepMatch.js          ORB geometric similarity
  thumbnail.js          oriented preview data URLs
  fileAction.js         open / reveal / trash
```
