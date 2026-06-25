import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html } from '/modules/kempo-ui/dist/lit-all.min.js';
import Dialog from '/modules/kempo-ui/dist/components/Dialog.js';
import { shared } from '/lib/styles.js';
import './dup-controls.js';
import './dup-results.js';
import './dup-detail.js';
import {
  initCache, selectIn, bulkUpsert, embToB64, b64ToEmb, clearCache, removeFromCache,
  buildCandidatePairs, clusterPairs, remapOrb, OrbMatcher, pairKey, markNotDuplicates, getExcludedPairs
} from '/lib/engine.js';

// window.api holds built-ins; custom api/*.js are reached via api.call(name,...).
const api = new Proxy({}, {
  get(_t, prop) {
    if (prop in window.api && typeof window.api[prop] !== 'undefined') return window.api[prop];
    return (...args) => window.api.call(prop, ...args);
  }
});

// kempo-ui Dialog wrapped as awaitable promises (no native alert/confirm).
const confirmDialog = (text, opts = {}) => new Promise((res) => Dialog.confirm(text, res, opts));
const alertDialog = (text, opts = {}) => new Promise((res) => Dialog.alert(text, res, opts));
const errorDialog = (text, opts = {}) => new Promise((res) => Dialog.error(text, res, opts));

const DEFAULT_SETTINGS = { recursive: true, usePhash: true, useNN: true, useGeo: true, preferGPU: true, confirmDelete: true, maxGroupSize: 10, thumbSize: 'medium' };
// Per-tier match thresholds (%). Neural defaults high so it groups only
// near-identical images, not "same subject" look-alikes.
const DEFAULT_THRESHOLDS = { phash: 70, nn: 90, geo: 55 };

class DupApp extends ShadowComponent {
  static properties = {
    dirs: { type: Array },
    settings: { type: Object },
    thresholds: { type: Object },
    scanning: { type: Boolean },
    progress: { type: Object },
    groups: { type: Array },
    selectedId: { type: Number },
    lastScan: { type: Object }
  };

  constructor() {
    super();
    this.dirs = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.thresholds = { ...DEFAULT_THRESHOLDS };
    this.scanning = false;
    this.progress = null;
    this.groups = [];
    this.selectedId = null;
    this.lastScan = null;
    this._items = [];
    this._pairs = [];
    this._excluded = new Set(); // pairKey(hashA,hashB) for user-confirmed not-duplicates
    this._cancelRequested = false;
    this._orb = new OrbMatcher();
    this.#loadConfig();
  }

  // titlebar.html lives outside this component (injected into the same document by
  // kempo-app's shell), so it reaches us via a plain document-level CustomEvent
  // rather than a bubbling shadow-DOM event.
  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('menu-action', this.onMenuAction);
    document.addEventListener('keydown', this.onGlobalKeydown);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('menu-action', this.onMenuAction);
    document.removeEventListener('keydown', this.onGlobalKeydown);
  }

  onMenuAction = (e) => {
    const { value } = e.detail;
    if (value === 'add-folder') this.onAddFolder();
    else if (value === 'reload-app') location.reload();
    else if (value === 'clear-cache') this.onClearCache();
    else if (value === 'reset-settings') this.onResetSettings();
    else if (value === 'keyboard-controls') this.#showKeyboardControls();
  };

  // Enter opens the first photo of the selected dupe set, Delete runs Auto Delete on it,
  // Backspace runs Delete Selected, ` (or ~) runs Not Duplicates, and Up/Down move the
  // selection to the previous/next dupe set — but not while focus is on a
  // button/link/input/dialog, where those keys already do something else
  // (activate, submit, confirm, delete-current-photo).
  onGlobalKeydown = async (e) => {
    const isNav = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const isTilde = e.key === '~' || e.key === '`';
    if (e.key !== 'Enter' && e.key !== 'Delete' && e.key !== 'Backspace' && !isTilde && !isNav) return;
    const path = e.composedPath();
    const target = path[0];
    const tag = target?.tagName;
    if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (target?.isContentEditable) return;
    if (path.some(el => el?.tagName === 'K-DIALOG')) return;
    if (!this.groups.find(g => g.id === this.selectedId)) return;
    const detail = this.shadowRoot.querySelector('dup-detail');
    const viewerOpen = !!document.querySelector('k-photo-viewer[fullscreen]');
    if (e.key === 'Enter') {
      detail?.openFirst();
    } else if (e.key === 'Delete') {
      // The Photo Viewer (if open) handles Delete itself — see dup-detail.js's #wireViewerDelete.
      if (!viewerOpen) detail?.triggerAutoDelete();
    } else if (e.key === 'Backspace') {
      detail?.triggerDeleteSelected();
    } else if (isTilde) {
      detail?.triggerNotDuplicates();
    } else if (isNav) {
      const idx = this.groups.findIndex(g => g.id === this.selectedId);
      const nextIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
      if (nextIdx < 0 || nextIdx >= this.groups.length) return;
      this.selectedId = this.groups[nextIdx].id;
      await this.#syncViewerToSelection();
    }
  };

  async #showKeyboardControls() {
    await alertDialog(`
      <div class="p">
        <div class="table-wrapper mb">
          <table class="wfull">
            <thead><tr><th>Key</th><th>When</th><th>Action</th></tr></thead>
            <tbody>
              <tr><td><strong>Up</strong> / <strong>Down</strong></td><td>Always</td><td>Select the previous/next dupe set (also updates the open Photo Viewer, if any)</td></tr>
              <tr><td><strong>Enter</strong></td><td>Always</td><td>Open the first photo of the selected dupe set in the Photo Viewer</td></tr>
              <tr><td><strong>Delete</strong></td><td>Not in Photo Viewer</td><td>Auto Delete the selected dupe set</td></tr>
              <tr><td><strong>Backspace</strong></td><td>Always</td><td>Delete the checked images, if any are checked</td></tr>
              <tr><td><strong>&#96;</strong> / <strong>~</strong></td><td>Always</td><td>Mark the selected dupe set as Not Duplicates</td></tr>
              <tr><td><strong>Left</strong> / <strong>Right</strong></td><td>Only in Photo Viewer</td><td>Move through the photos</td></tr>
              <tr><td><strong>Delete</strong></td><td>Only in Photo Viewer</td><td>Delete the photo currently shown</td></tr>
              <tr><td><strong>Esc</strong></td><td>Only in Photo Viewer</td><td>Close the viewer</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `, { title: 'Keyboard Controls', cancelText: '' });
  }

  // Persist the enabled algorithms, the two setting toggles, the thresholds, and the
  // selected folders.
  #loadConfig() {
    try {
      const c = JSON.parse(localStorage.getItem('dup-config') || '{}');
      if (c.settings) this.settings = { ...this.settings, ...c.settings };
      if (c.thresholds) this.thresholds = { ...this.thresholds, ...c.thresholds };
      if (Array.isArray(c.dirs)) this.dirs = c.dirs;
    } catch { /* ignore corrupt config */ }
  }
  #saveConfig() {
    try { localStorage.setItem('dup-config', JSON.stringify({ settings: this.settings, thresholds: this.thresholds, dirs: this.dirs })); } catch { /* noop */ }
  }

  #setProgress(p, text) { this.progress = p == null ? null : { p, text }; }

  // Build the settings+thresholds object for clustering. Thresholds use the *rounded*
  // (displayed) value so results are deterministic for a given shown %, not drifting
  // across the slider's fractional value.
  #clusterSettings() {
    const t = this.thresholds;
    return {
      ...this.settings,
      tPhash: Math.round(t.phash) / 100,
      tNN: Math.round(t.nn) / 100,
      tGeo: Math.round(t.geo) / 100
    };
  }

  // `advance`: skip the member-overlap lookup and instead reselect whatever now sits
  // in the same list position the current selection had — for actions that mean to
  // dissolve the current set entirely (e.g. Not Duplicates), where "stay on this set"
  // doesn't apply and "move to the next one" is what's wanted instead.
  #recluster({ advance = false } = {}) {
    const prevIdx = this.groups.findIndex(g => g.id === this.selectedId);
    // Group ids are positional, so anchor the open detail on its actual member images:
    // re-point to whichever new group still contains them, falling back to the top
    // result (groups are pre-sorted by match strength) if that set is gone — or if
    // nothing was selected yet, e.g. right after a scan.
    const prevMembers = !advance && prevIdx !== -1 ? new Set(this.groups[prevIdx].members) : null;

    this.groups = clusterPairs(this._items, this._pairs, this.#clusterSettings(), this._excluded);

    if (advance) {
      const idx = Math.min(Math.max(prevIdx, 0), this.groups.length - 1);
      this.selectedId = this.groups[idx]?.id ?? null;
    } else if (prevMembers) {
      const ng = this.groups.find(g => g.members.some(m => prevMembers.has(m)));
      this.selectedId = ng ? ng.id : (this.groups[0]?.id ?? null);
    } else if (this.selectedId == null) {
      this.selectedId = this.groups[0]?.id ?? null;
    }
  }

  // If the Photo Viewer is open, reopen it on the first photo of whatever's selected
  // now. dup-detail.js's #openViewer() already closes any viewer still open before
  // showing the new one, so this alone covers "switch without stacking".
  async #syncViewerToSelection() {
    if (!document.querySelector('k-photo-viewer[fullscreen]')) return;
    await this.updateComplete;
    this.shadowRoot.querySelector('dup-detail')?.openFirst();
  }

  /* ---------- control events ---------- */
  onAddFolder = async () => {
    const picked = await api.selectDirectories();
    const next = [...this.dirs];
    for (const p of picked) if (!next.includes(p)) next.push(p);
    this.dirs = next;
    this.#saveConfig();
  };
  onRemoveDir = (e) => {
    const n = [...this.dirs];
    n.splice(e.detail.index, 1);
    this.dirs = n;
    this.#saveConfig();
    // The current results/selection were computed including this folder, so they're
    // stale now — clear them rather than leaving results for images that may no
    // longer be in scope until the next scan.
    document.querySelectorAll('k-photo-viewer[fullscreen]').forEach(v => v.close());
    this._items = []; this._pairs = []; this.groups = []; this.selectedId = null; this.lastScan = null;
  };
  onSettingChange = (e) => { this.settings = { ...this.settings, [e.detail.key]: e.detail.value }; this.#saveConfig(); if (this._items.length) this.#recluster(); };
  onThresholdChange = (e) => { this.thresholds = { ...this.thresholds, [e.detail.tier]: e.detail.value }; this.#saveConfig(); if (this._items.length) this.#recluster(); };
  onStartScan = () => this.scan();
  onCancelScan = async () => {
    if (!this.scanning) return;
    const ok = await confirmDialog('Stop the current scan? Anything already analyzed stays cached, and you\'ll see results for whatever finished so far.', { title: 'Cancel Scan' });
    if (!ok) return;
    this._cancelRequested = true;
  };
  onClearCache = async () => {
    const ok = await confirmDialog('Clear the cached hashes, features, comparisons and "not duplicate" marks? The next scan will recompute everything from scratch.', { title: 'Clear cache' });
    if (!ok) return;
    try {
      await clearCache();
      this._excluded = new Set();
      if (this._items.length) this.#recluster();
      await alertDialog('Cache cleared.');
    } catch (e) { await errorDialog('Could not clear cache: ' + (e?.message || e)); }
  };

  onResetSettings = async () => {
    const ok = await confirmDialog('Reset all detection settings and thresholds back to their defaults?', { title: 'Reset settings' });
    if (!ok) return;
    this.settings = { ...DEFAULT_SETTINGS };
    this.thresholds = { ...DEFAULT_THRESHOLDS };
    this.#saveConfig();
    if (this._items.length) this.#recluster();
    await alertDialog('Settings reset.');
  };

  /* ---------- result / detail events ---------- */
  onSelectGroup = (e) => { this.selectedId = e.detail.id; };
  onFileAction = async (e) => {
    const { action, path, onDone } = e.detail;
    if (action === 'trash') {
      if (this.settings.confirmDelete) {
        const ok = await confirmDialog(`<p class="p">Move this file to the Recycle Bin?<br><span class="small tc-muted">${path}</span></p>`,
          { title: 'Move to Trash', confirmText: 'Trash', confirmClasses: 'danger ml', cancelText: 'Cancel', cancelClasses: 'secondary' });
        if (!ok) { onDone?.(false); return; }
      }
      const r = await api.fileAction('trash', path);
      if (!r.ok) { await errorDialog('Could not delete the file: ' + (r.error || 'unknown error')); onDone?.(false); return; }
      await this.#removeItem(path);
      onDone?.(true);
      return;
    }
    const r = await api.fileAction(action, path);
    if (r && r.ok === false) await errorDialog(`Could not ${action} the file: ` + (r.error || 'unknown error'));
  };

  onAutoDelete = async (e) => {
    const { keepName, deletePaths } = e.detail;
    await this.#trashPaths(deletePaths, 'Auto Delete',
      `<p class="p">Keep <strong>${keepName}</strong> and move the other ${deletePaths.length} image(s) to the Recycle Bin?</p>`);
  };

  onDeleteSelected = async (e) => {
    const { paths } = e.detail;
    await this.#trashPaths(paths, 'Delete Selected',
      `<p class="p">Move the selected ${paths.length} image(s) to the Recycle Bin?</p>`);
  };

  // Permanently record that these images aren't duplicates of each other, so future
  // scans never re-link or re-verify them — then reflect that immediately by dropping
  // their pairwise links from the current results, without needing a rescan.
  onNotDuplicates = async (e) => {
    const { paths } = e.detail;
    const hashes = [...new Set(paths.map(p => this._items.find(i => i.path === p)?.hash).filter(Boolean))];
    if (hashes.length < 2) return;

    await markNotDuplicates(hashes);

    // Reflect it immediately without a rescan — clusterPairs reads this set on every
    // recluster, so it'll keep these images apart (directly and transitively) from here on.
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) this._excluded.add(pairKey(hashes[i], hashes[j]));
    }
    // The marked set is gone for good (those members can never group together again),
    // so move to whatever now sits in the same list position rather than trying to
    // find "the same set" — and keep the Photo Viewer in sync if it's open.
    this.#recluster({ advance: true });
    await this.#syncViewerToSelection();
  };

  // Shared multi-file trash flow: a single confirm (respecting the confirmDelete
  // setting), then trash + remove each path, stopping on the first failure.
  async #trashPaths(paths, title, confirmHtml) {
    if (!paths.length) return;

    if (this.settings.confirmDelete) {
      const ok = await confirmDialog(confirmHtml,
        { title, confirmText: 'Delete', confirmClasses: 'danger ml', cancelText: 'Cancel', cancelClasses: 'secondary' });
      if (!ok) return;
    }

    for (const path of paths) {
      const r = await api.fileAction('trash', path);
      if (!r.ok) { await errorDialog('Could not delete the file: ' + (r.error || 'unknown error')); return; }
      await this.#removeItem(path);
    }
  }

  async #removeItem(path) {
    const idx = this._items.findIndex(i => i.path === path);
    if (idx === -1) return;
    const hash = this._items[idx].hash;

    // Remember the other members of the currently-selected set so we can re-select it.
    const selBefore = this.groups.find(g => g.id === this.selectedId);
    const survivingPaths = selBefore
      ? selBefore.members.map(mi => this._items[mi].path).filter(p => p !== path)
      : [];

    this._items = this._items.filter((_, i) => i !== idx);
    this._pairs = this._pairs
      .filter(p => p.i !== idx && p.j !== idx)
      .map(p => ({ ...p, i: p.i > idx ? p.i - 1 : p.i, j: p.j > idx ? p.j - 1 : p.j }));

    // Cache cleanup: always drop the path; drop the hash only if no item still uses it.
    const hashStillUsed = this._items.some(i => i.hash === hash);
    try { await removeFromCache(path, hash, !hashStillUsed); } catch (e) { console.warn('cache cleanup failed', e); }

    this.#recluster();

    // Keep viewing the same set if it still exists (>2 imgs); otherwise fall back to
    // the top result (was a pair, or the set dropped below 2 members).
    if (survivingPaths.length) {
      const survivors = new Set(survivingPaths);
      const ng = this.groups.find(g => g.members.some(mi => survivors.has(this._items[mi].path)));
      this.selectedId = ng ? ng.id : (this.groups[0]?.id ?? null);
    } else {
      this.selectedId = this.groups[0]?.id ?? null;
    }
  }

  /* ---------- scan pipeline (cache-aware) ---------- */
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this._cancelRequested = false;
    this._items = []; this._pairs = []; this.groups = []; this.selectedId = null;
    this._orb.dispose();

    try {
      this.#setProgress(0, 'Scanning folders…');
      const files = await api.scanImages(this.dirs, { recursive: this.settings.recursive });
      if (!files.length) { this.#setProgress(null); await alertDialog('No images found in the selected folder(s).'); return; }

      const { useNN, usePhash, useGeo, preferGPU } = this.settings;
      const MODEL = useNN ? 'Xenova/dinov2-small' : 'phash-only';
      await initCache();

      // 1) Resolve content hashes — reuse cached hashes for unchanged paths.
      this.#setProgress(0.02, 'Identifying files…');
      const pathCache = await selectIn('paths', 'path,size,mtime,hash', 'path', files.map(f => f.path));
      const needHash = [];
      for (const f of files) {
        const c = pathCache.get(f.path);
        if (c && c.size === f.size && Math.abs(c.mtime - f.mtime) < 1 && c.hash) f.hash = c.hash;
        else needHash.push(f);
      }
      if (needHash.length) {
        const HB = 64, newPathRows = [];
        for (let i = 0; i < needHash.length; i += HB) {
          if (this._cancelRequested) break;
          const slice = needHash.slice(i, i + HB);
          const ids = await api.fileIdentities(slice.map(f => f.path));
          ids.forEach((id, k) => { const f = slice[k]; if (id.hash) { f.hash = id.hash; newPathRows.push({ path: f.path, size: id.size, mtime: id.mtime, hash: id.hash }); } });
          this.#setProgress(0.02 + 0.08 * (Math.min(i + HB, needHash.length) / needHash.length), `Identifying files… ${Math.min(i + HB, needHash.length)} / ${needHash.length}`);
        }
        await bulkUpsert('paths', ['path', 'size', 'mtime', 'hash'], newPathRows);
      }

      const items = files.filter(f => f.hash).map(f => ({ path: f.path, name: f.name, size: f.size, hash: f.hash, phash: null, embedding: null }));
      const uniqueHashes = [...new Set(items.map(i => i.hash))];

      // 2) Features per unique hash — load from cache, compute only the misses.
      const featRows = await selectIn('images', 'hash,phash,embedding,model', 'hash', uniqueHashes);
      const featByHash = new Map();
      for (const h of uniqueHashes) {
        const r = featRows.get(h);
        if (r && r.model === MODEL) featByHash.set(h, { phash: r.phash ? JSON.parse(r.phash) : null, embedding: r.embedding ? b64ToEmb(r.embedding) : null });
      }
      const missingHashes = uniqueHashes.filter(h => !featByHash.has(h));
      const repPath = new Map();
      for (const it of items) if (!repPath.has(it.hash)) repPath.set(it.hash, it.path);

      if (missingHashes.length) {
        if (useNN) {
          this.#setProgress(0.1, 'Loading neural model (first run downloads it)…');
          const info = await api.initEngine({ preferGPU });
          if (info.ok) this.#setProgress(0.12, `Model ready on ${String(info.device).toUpperCase()}.`);
          else console.warn('Engine init failed:', info.error);
        }
        const BATCH = 8, imgRows = [];
        for (let i = 0; i < missingHashes.length; i += BATCH) {
          if (this._cancelRequested) break;
          const slice = missingHashes.slice(i, i + BATCH);
          const res = await api.embedImages(slice.map(h => repPath.get(h)), { useNN, usePhash });
          res.forEach((r, k) => {
            const h = slice[k];
            featByHash.set(h, { phash: r.phash || null, embedding: r.embedding || null });
            imgRows.push({ hash: h, phash: r.phash ? JSON.stringify(r.phash) : null, embedding: r.embedding ? embToB64(r.embedding) : null, model: MODEL, w: null, h: null });
          });
          this.#setProgress(0.12 + 0.55 * (Math.min(i + BATCH, missingHashes.length) / missingHashes.length), `Analyzing new images… ${Math.min(i + BATCH, missingHashes.length)} / ${missingHashes.length}`);
        }
        await bulkUpsert('images', ['hash', 'phash', 'embedding', 'model', 'w', 'h'], imgRows);
      }

      for (const it of items) { const f = featByHash.get(it.hash); if (f) { it.phash = f.phash; it.embedding = f.embedding; } }
      this._items = items;
      const summary = { files: items.length, unique: uniqueHashes.length, newFeat: missingHashes.length, reusedFeat: uniqueHashes.length - missingHashes.length, newOrb: 0, reusedOrb: 0 };

      this._pairs = buildCandidatePairs(this._items);

      // Load every user-confirmed not-duplicate pair (clusterPairs needs the full set to
      // catch transitive conflicts, not just direct candidate pairs — see its comment).
      // Drop directly-excluded candidate pairs now too, purely so ORB doesn't waste time
      // geometrically verifying a pair we already know must never link.
      this._excluded = await getExcludedPairs();
      if (this._excluded.size) {
        const keyOf = (p) => pairKey(this._items[p.i].hash, this._items[p.j].hash);
        this._pairs = this._pairs.filter(p => !this._excluded.has(keyOf(p)));
      }

      // 3) Geometric verification. The neural embedding only *finds candidates* here;
      //    grouping requires real copy evidence (ORB overlap or pHash) — see pairScore.
      //    Verify the most-similar candidate pairs first (highest embedding/pHash).
      if (useGeo && !this._cancelRequested) {
        const ORB_CAP = 6000;
        const sim = (p) => Math.max(p.sEmbed, p.sPhash);
        const keyOf = (p) => pairKey(this._items[p.i].hash, this._items[p.j].hash);
        const border = this._pairs
          .filter(p => this._items[p.i].hash !== this._items[p.j].hash && sim(p) >= 0.2)
          .sort((a, b) => sim(b) - sim(a))
          .slice(0, ORB_CAP);
        if (border.length) {
          const keys = border.map(keyOf);
          const orbCacheMap = await selectIn('orbcache', 'pair,score', 'pair', keys);
          const toCompute = [];
          border.forEach((p, k) => { const c = orbCacheMap.get(keys[k]); if (c) p.sOrb = remapOrb(c.score); else toCompute.push({ p, key: keys[k] }); });
          summary.reusedOrb = border.length - toCompute.length;
          summary.newOrb = toCompute.length;
          if (toCompute.length) {
            this.#setProgress(0.7, 'Loading geometric matcher…');
            let cvOk = true;
            try { await this._orb.ensure(); } catch (e) { cvOk = false; console.warn('Geometric tier unavailable:', e.message); }
            if (cvOk) {
              const orbRows = [];
              let done = 0;
              await this._orb.matchAll(
                toCompute,
                (job) => [this._items[job.p.i].path, this._items[job.p.j].path],
                (_idx, orb, job) => {
                  if (orb != null) { job.p.sOrb = remapOrb(orb); orbRows.push({ pair: job.key, score: orb }); }
                  done++;
                  if (done % 5 === 0 || done === toCompute.length) this.#setProgress(0.7 + 0.28 * (done / toCompute.length), `Verifying geometry… ${done} / ${toCompute.length} new`);
                },
                () => this._cancelRequested
              );
              await bulkUpsert('orbcache', ['pair', 'score'], orbRows);
            }
          }
        }
      }
      this.lastScan = summary;

      this.#setProgress(1, 'Clustering…');
      this.#recluster();
      this.#setProgress(null);
      if (this._cancelRequested) await alertDialog('Scan cancelled — showing results for what finished so far. Anything already analyzed stays cached.');
    } catch (e) {
      console.error(e); this.#setProgress(null); await errorDialog('Scan failed: ' + (e?.message || e));
    } finally {
      this.scanning = false;
    }
  }

  render() {
    const selGroup = this.groups.find(g => g.id === this.selectedId) || null;
    return html`
      <k-split persistent-id="dup-outer" grip style="height:calc(100vh - var(--app-titlebar-height, 0px)); --pane_1_size:25%;">
        <dup-controls
          .dirs=${this.dirs} .settings=${this.settings} .thresholds=${this.thresholds}
          .scanning=${this.scanning} .progress=${this.progress}
          @add-folder=${this.onAddFolder} @remove-dir=${this.onRemoveDir}
          @setting-change=${this.onSettingChange} @threshold-change=${this.onThresholdChange}
          @start-scan=${this.onStartScan} @cancel-scan=${this.onCancelScan} @clear-cache=${this.onClearCache}
          @reset-settings=${this.onResetSettings}></dup-controls>

        <k-split slot="right" persistent-id="dup-inner" grip style="height:100%; --pane_1_size:33.333%;">
          <dup-results
            .groups=${this.groups} .items=${this._items} .selectedId=${this.selectedId} .summary=${this.lastScan}
            .scanning=${this.scanning}
            @select-group=${this.onSelectGroup}></dup-results>
          <dup-detail slot="right"
            .group=${selGroup} .items=${this._items} .settings=${this.settings}
            @file-action=${this.onFileAction} @auto-delete=${this.onAutoDelete}
            @delete-selected=${this.onDeleteSelected} @not-duplicates=${this.onNotDuplicates}
            @setting-change=${this.onSettingChange}></dup-detail>
        </k-split>
      </k-split>`;
  }

  static styles = [shared];
}

customElements.define('dup-app', DupApp);
