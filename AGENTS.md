# AGENTS.md

## Overview

**Image Deduper** is an Electron desktop app that finds duplicate images even when they're cropped, rotated, scaled, filtered, recompressed, or watermarked. It's built on **kempo-app** (the Electron framework) and **kempo-ui** (Lit web components), both Dustin's own packages.

The detection engine is **4-tier**, runs entirely in-process (no Python), and caches aggressively in SQLite:
1. **pHash** — perceptual hash; catches re-saves, rescales, 90° rotations, mirror flips.
2. **Neural (DINOv2)** — `@huggingface/transformers`, GPU/DML when available; finds edited/filtered look-alikes (only used to *find candidates*).
3. **Geometric (ORB)** — `@techstark/opencv-js`; keypoint+geometry match; per-pair, so it's the slow one.
4. **Copy detection (SSCD)** — `onnxruntime-node` on a converted ONNX (`tools/sscd/convert.py`); trained to match *copies* of an image but NOT different photos of the same subject, which is what the DINOv2 tier gets wrong. Most accurate tier; model is gitignored and must be built or downloaded.

See the `image-deduper-engine` memory for engine gotchas.

## Running / Dev

```sh
npm run dev      # Electron + DevTools, CDP on port 9222, Node inspector on 5858
npm start        # production mode
```

Native deps (`sharp`, `better-sqlite3`, `@techstark/opencv-js`) are already built; a plain
`npm install <jsdep>` for kempo-* packages can use `--ignore-scripts` to avoid rebuilding them.

### Inspecting the running app (CDP)

`npm run dev` exposes CDP on **port 9222**:

```sh
curl http://localhost:9222/json/list     # renderer target title = "Image Deduper"
```

Connect any CDP client to the target's `webSocketDebuggerUrl` to evaluate JS, read console,
take screenshots, or drive clicks. `npm run interact -- <cmd>` is the higher-level wrapper.
**`preload.cjs` / renderer changes take effect on a window reload; main-process (`api/*.js`,
`backend.js`) changes need a full restart.**

## Architecture

```
app.js                  Renderer entry — registers kempo-ui components + App
pages/index.html        <k-context>s wrapping <id-app> (app-level state)
shell.html              kempo-app shell (<app-page>)
titlebar.html           Menu → dispatches document 'menu-action' events
theme.css               kempo-css variable overrides
components/              Web components (one per file, PascalCase, default export, <id-*> tags)
  App.js                Orchestrator: scan pipeline + results, owns engine state
  Controls.js           Left pane: sources, detection tiers, settings
  Results.js            Middle pane: duplicate-set list
  Detail.js             Right pane: images of the selected set + actions
  Dupe.js               One duplicate-set row in Results (owns its thumbnail)
  ImageCard.js          One image tile in Detail (owns its thumbnail)
  Scores.js             Per-tier % score widget, shared by Dupe + Detail's header
  SourceCard.js         Reference/Search import card in Controls
  SourceItem.js         One source path row inside a SourceCard
  ToggleSlider.js       Enable-toggle + threshold slider/input, one per detection tier
  SliderInput.js        Slider + editable number box (threshold % or integer settings)
  CompareViewer.js      Fullscreen wipe-compare overlay
lib/
  engine.js             Clustering, caching (incl. GC), ORB matcher, thumbnails (renderer side)
  api.js                Proxy over window.api (custom api/*.js via window.api.call)
  contexts.js           getConfig/getUI — locate the k-context elements
  styles.js             Shared Lit styles
src/                    Main-process feature extraction (imported by api/*.js, not window.api)
  engine.js             pHash + DINOv2 embedding
  sscd.js               SSCD copy-detection embedding (ONNX Runtime)
api/                    Main-process custom handlers → window.api.<name>()
  scanImages, selectImages, selectDirectories, fileIdentities, thumbnail,
  embedImages, grayBuffer, initEngine, initSscd, fileAction
models/                 Bundled SSCD weights (models/README.md)
tools/                  Dev-only: calibrate.js (accuracy harness over example/), sscd/ (ONNX conversion)
```

### Detection engine internals

- **Clustering is complete-linkage, not transitive chaining.** `clusterPairs` (`lib/engine.js`)
  requires *every* pair within a candidate group — not just the one pair that triggered the
  merge — to individually clear a `cohesion` floor (default 50% of each tier's own
  threshold) before merging. Prevents A↔B↔C chains where A and C aren't actually alike.
  `cohesion: 0` restores old single-linkage behavior.
- **A group's displayed score is the average of every in-group pair**, not the strongest
  pair's — an unscored pair (below every tier's candidate floor) counts as 0. The % reflects
  how alike the whole set is, not just its best link.
- **Cache is keyed by content hash (SHA-256), not path.** Editing a file outside the app
  gives it a new hash. `App.js`'s scan pipeline then calls `migrateExcludedPairs()` (carries
  "Not Duplicate" decisions from the old hash to the new one — copies rather than moves,
  since the old hash may still belong to an untouched second copy) and `gcCache()` (drops
  `images`/`orbcache` rows nothing in `paths` references anymore; never touches
  `excluded_pairs` — a temporarily-unreferenced hash, e.g. an unplugged drive, must not
  lose its exclusions).

### App-level state lives in two `k-context`s

`pages/index.html` wraps `<dup-app>` in two contexts; components reach them across
`dup-app`'s shadow boundary via `closestAcrossShadow` (a kempo-ui util) — native
`closest()` can't cross shadow roots. See `lib/contexts.js`.

| Context | Persisted? | Holds | Selector |
|---------|-----------|-------|----------|
| `dup-config` | yes (`persistent-id` → localStorage) | `settings`, `thresholds`, `sources` | `k-context[persistent-id="dup-config"]` |
| `dup-ui` | no | `selectedId` | `k-context.dup-ui` |

- `DupControls`/`DupDetail` read+write config directly; `DupApp` listens for `context:set`
  to re-cluster (settings/thresholds) or clear stale results (a removed source).
- `DupResults` writes `selectedId`; `DupApp` reads it to compute the selected group.
- `DupApp` still **owns** the non-serializable scan pipeline: `items`, `groups`, candidate
  pairs, the ORB matcher, `scanning`/`progress` — these never go in a context.
- First run seeds `dup-config` (migrating once from the old `localStorage['dup-config']` key).

## Coding standards

Components follow the skills in `.claude/skills/` (copied from
[kempo-skills](https://github.com/dustinpoissant/kempo-skills)):
`component-code`, `code-conventions`, `styles`. Key points: one component per file, filename =
PascalCase class name, `export default`; sectioned with `/* ... */` comments; **no `#`-private**
(Safari) — use module-scoped `Symbol()` keys defined/assigned in the constructor; reactive
state only when `render()` must react, otherwise a symbol.

**Toast vs Dialog**: `Toast.success/warning/error/create` for anything that only conveys a
result with no decision to make (scan cancelled, an action failed, settings reset) — it
auto-dismisses and never blocks. `Dialog.confirm` (via `confirmDialog` in `App.js`) is only
for an actual yes/no the user must answer before continuing (delete this? clear the cache?).
`alertDialog` is reserved for the one case that's neither — the Keyboard Controls reference
table, which the user opens deliberately and reads at their own pace.

## Dependency chain & updating

`kempo-ui` → `kempo-app` → `image-deduper`. To pull a new kempo-ui through:
1. Publish kempo-ui, then in kempo-app `npm install kempo-ui@^X`, commit/push (auto-publishes).
2. Here: `npm install kempo-app@^Y kempo-ui@^X --ignore-scripts`.

Both kempo-ui (`/modules/kempo-ui/dist/...`) and kempo-app are served at runtime from
`node_modules` via the `/modules/` protocol zone.

## Known gotcha: kempo-app preload `window.api`

kempo-app's `preload.cjs` historically tried `new Proxy(window.api, …)` *after*
`contextBridge.exposeInMainWorld` — but under `contextIsolation` the preload's `window.api`
is `undefined`, so the proxy throws, the preload dies, and `window.api.call` never attaches
(every `api.*` call then throws `window.api.call is not a function`). Fixed by adding a
`call(name, ...args)` method to `baseAPI` *before* exposing it and deleting the post-exposure
proxy block. If a `kempo-app` reinstall ever reintroduces this, re-check
`node_modules/kempo-app/src/main/preload.cjs` (and that the fix shipped upstream). See the
`kempo-app-custom-api-bug` memory.
