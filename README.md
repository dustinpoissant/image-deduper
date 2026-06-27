# Image Deduper

An Electron desktop app that finds duplicate images even when they've been
**cropped, rotated, scaled, re-filtered/toned, or watermarked**. Built on
[kempo-app](https://github.com/dustinpoissant/kempo-app) (Electron framework) and
[kempo-ui](https://github.com/dustinpoissant/kempo-ui) (Lit web components).

This README is for people building or contributing to the app. If you just want to use
it, see the [user docs](https://dustinpoissant.github.io/image-deduper/) instead.

## Setup

```sh
npm install
npm run dev       # Electron + DevTools, CDP on port 9222, Node inspector on 5858
# or
npm start         # production mode, no DevTools
```

Native deps (`sharp`, `better-sqlite3`, `@techstark/opencv-js`) ship with prebuilt
binaries already matched to Electron's ABI — no local build toolchain required for a
normal `npm install`.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Electron + DevTools, CDP on 9222, Node inspector on 5858 |
| `npm start` | Production mode |
| `npm test` | Runs the test suite (`kempo-test`) |
| `npm run interact` | CDP-driven interaction CLI (`kempo-interact`), useful for scripting/inspecting a running window |
| `npm run package` | Builds an unpacked app folder (`dist/`) for the host OS, no installer |
| `npm run make` | Builds a real installer for the host OS — NSIS wizard on Windows, AppImage/deb on Linux |
| `npm run docs` | Serves `docs/` locally at `http://localhost:8080` |

`package`/`make` never cross-compile — they build for whatever OS they're run on. See
[kempo-app](https://github.com/dustinpoissant/kempo-app) for how packaging works under
the hood.

## How the detection engine works

Three tiers, run entirely in-process (no Python, no external services):

| Tier | Tech | Catches | Cost |
|---|---|---|---|
| 1. Perceptual hash | `sharp` + 32×32 DCT pHash (8 dihedral orientations) | exact dupes, rescales, recompression, 90° rotations & mirrors | trivial |
| 2. Neural embeddings | DINOv2 via `@huggingface/transformers` (native `onnxruntime-node`, GPU→CPU) | crop, arbitrary rotation, scale, filters/tone, watermark | one inference per image |
| 3. Geometric verification | ORB + RANSAC homography via `@techstark/opencv-js` | confirms true geometric overlap on borderline pairs | only borderline pairs |

Each tier has its own enable toggle and confidence threshold (left pane, **Detection
Algorithms**) — a pair links into a duplicate set if *any* enabled tier clears its
threshold. Clustering lives in `lib/engine.js`.

Results are cached in SQLite (`better-sqlite3`, via kempo-app's DB, under the app's
userData dir), keyed by **content hash** (SHA-256) rather than path, so a rename or move
never invalidates the cache. Pairs marked **Not Duplicates** are persisted in
`excluded_pairs` so they (and anything transitively linked to them) never re-group.

Sources are split into **Reference** (trusted images, never compared to each other) and
**Search** (the images being checked — against references, or against each other if
there are no references). This guarantees two references can never get merged into the
same duplicate group.

## Contributing

Issues and PRs welcome. Component code follows the conventions in
[AGENTS.md](AGENTS.md) (one component per file, sectioned Lit components, no `#`-private
fields). Run `npm test` before opening a PR.
