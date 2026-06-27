import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html } from '/modules/kempo-ui/dist/lit-all.min.js';
import Dialog from '/modules/kempo-ui/dist/components/Dialog.js';
import { shared } from '/lib/styles.js';
import api from '/lib/api.js';
import { getConfig, getUI } from '/lib/contexts.js';
import './Controls.js';
import './Results.js';
import './Detail.js';
import {
  initCache, selectIn, bulkUpsert, embToB64, b64ToEmb, clearCache, removeFromCache,
  buildCandidatePairs, clusterPairs, remapOrb, OrbMatcher, pairKey, markNotDuplicates, getExcludedPairs
} from '/lib/engine.js';

/*
  Utility Functions
*/
// kempo-ui Dialog wrapped as awaitable promises (no native alert/confirm).
const confirmDialog = (text, opts = {}) => new Promise(res => Dialog.confirm(text, res, opts));
const alertDialog = (text, opts = {}) => new Promise(res => Dialog.alert(text, res, opts));
const errorDialog = (text, opts = {}) => new Promise(res => Dialog.error(text, res, opts));

const DEFAULT_SETTINGS = { recursive: true, usePhash: true, useNN: true, useGeo: true, preferGPU: true, confirmDelete: true, maxGroupSize: 10, thumbSize: 'medium', deprioritizeScreenshots: true };
// Per-tier match thresholds (%). Neural defaults high so it groups only
// near-identical images, not "same subject" look-alikes.
const DEFAULT_THRESHOLDS = { phash: 70, nn: 90, geo: 55 };

/*
  Symbols
*/
const cfgEl = Symbol('cfgEl');
const uiEl = Symbol('uiEl');
const pairs = Symbol('pairs');
const excluded = Symbol('excluded');
const cancelRequested = Symbol('cancelRequested');
const orb = Symbol('orb');
const seedConfig = Symbol('seedConfig');
const setProgress = Symbol('setProgress');
const clusterSettings = Symbol('clusterSettings');
const recluster = Symbol('recluster');
const syncViewerToSelection = Symbol('syncViewerToSelection');
const trashPaths = Symbol('trashPaths');
const removeItem = Symbol('removeItem');
const showKeyboardControls = Symbol('showKeyboardControls');

export default class App extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    scanning: { type: Boolean },
    progress: { type: Object },
    groups: { type: Array },
    lastScan: { type: Object },
    // Read by render (passed to the results/detail panes), so it has to re-render the
    // children when it changes — hence reactive state rather than a private symbol.
    items: { state: true }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Members
    */
    this[cfgEl] = null; // dup-config context (settings/thresholds/sources), resolved on connect
    this[uiEl] = null; // dup-ui context (selectedId), resolved on connect
    this[pairs] = [];
    this[excluded] = new Set(); // pairKey(hashA,hashB) for user-confirmed not-duplicates
    this[cancelRequested] = false;
    this[orb] = new OrbMatcher();

    /*
      Private Methods
    */
    // First run (or a context with no persisted data yet): seed the config context with
    // defaults, migrating once from the pre-context localStorage key if it's there.
    this[seedConfig] = () => {
      const c = this[cfgEl];
      if (!c || c.has('settings')) return;
      let old = {};
      try { old = JSON.parse(localStorage.getItem('dup-config') || '{}'); } catch { /* ignore corrupt config */ }
      c.set('settings', { ...DEFAULT_SETTINGS, ...(old.settings || {}) });
      c.set('thresholds', { ...DEFAULT_THRESHOLDS, ...(old.thresholds || {}) });
      c.set('sources',
        (old.sources && Array.isArray(old.sources.reference) && Array.isArray(old.sources.search))
          ? old.sources
          // Migrate the pre-Reference/Search flat folder list into the Search set.
          : Array.isArray(old.dirs)
            ? { reference: [], search: old.dirs.map(p => ({ path: p, kind: 'folder' })) }
            : { reference: [], search: [] });
    };

    this[setProgress] = (p, text) => { this.progress = p == null ? null : { p, text }; };

    // Build the settings+thresholds object for clustering. Thresholds use the *rounded*
    // (displayed) value so results are deterministic for a given shown %, not drifting
    // across the slider's fractional value.
    this[clusterSettings] = () => {
      const t = this.thresholds;
      return {
        ...this.settings,
        tPhash: Math.round(t.phash) / 100,
        tNN: Math.round(t.nn) / 100,
        tGeo: Math.round(t.geo) / 100
      };
    };

    // `advance`: skip the member-overlap lookup and instead reselect whatever now sits
    // in the same list position the current selection had — for actions that mean to
    // dissolve the current set entirely (e.g. Not Duplicates), where "stay on this set"
    // doesn't apply and "move to the next one" is what's wanted instead.
    this[recluster] = ({ advance = false } = {}) => {
      const prevIdx = this.groups.findIndex(g => g.id === this.selectedId);
      // Group ids are positional, so anchor the open detail on its actual member images:
      // re-point to whichever new group still contains them, falling back to the top
      // result (groups are pre-sorted by match strength) if that set is gone — or if
      // nothing was selected yet, e.g. right after a scan.
      const prevMembers = !advance && prevIdx !== -1 ? new Set(this.groups[prevIdx].members) : null;

      this.groups = clusterPairs(this.items, this[pairs], this[clusterSettings](), this[excluded]);

      if (advance) {
        const idx = Math.min(Math.max(prevIdx, 0), this.groups.length - 1);
        this.selectedId = this.groups[idx]?.id ?? null;
      } else if (prevMembers) {
        const ng = this.groups.find(g => g.members.some(m => prevMembers.has(m)));
        this.selectedId = ng ? ng.id : (this.groups[0]?.id ?? null);
      } else if (this.selectedId == null) {
        this.selectedId = this.groups[0]?.id ?? null;
      }
    };

    // If the Photo Viewer is open, reopen it on the first photo of whatever's selected
    // now. DupDetail.js's openViewer already closes any viewer still open before
    // showing the new one, so this alone covers "switch without stacking".
    this[syncViewerToSelection] = async () => {
      if (!document.querySelector('k-photo-viewer[fullscreen]')) return;
      await this.updateComplete;
      this.shadowRoot.querySelector('id-detail')?.openFirst();
    };

    // Shared multi-file trash flow: a single confirm (respecting the confirmDelete
    // setting), then trash + remove each path, stopping on the first failure.
    this[trashPaths] = async (paths, title, confirmHtml) => {
      if (!paths.length) return;

      if (this.settings.confirmDelete) {
        const ok = await confirmDialog(confirmHtml,
          { title, confirmText: 'Delete', confirmClasses: 'danger ml', cancelText: 'Cancel', cancelClasses: 'secondary' });
        if (!ok) return;
      }

      for (const path of paths) {
        const r = await api.fileAction('trash', path);
        if (!r.ok) { await errorDialog('Could not delete the file: ' + (r.error || 'unknown error')); return; }
        await this[removeItem](path);
      }
    };

    this[removeItem] = async path => {
      const idx = this.items.findIndex(i => i.path === path);
      if (idx === -1) return;
      const hash = this.items[idx].hash;

      // Remember the other members of the currently-selected set so we can re-select it.
      const selBefore = this.groups.find(g => g.id === this.selectedId);
      const survivingPaths = selBefore
        ? selBefore.members.map(mi => this.items[mi].path).filter(p => p !== path)
        : [];

      this.items = this.items.filter((_, i) => i !== idx);
      this[pairs] = this[pairs]
        .filter(p => p.i !== idx && p.j !== idx)
        .map(p => ({ ...p, i: p.i > idx ? p.i - 1 : p.i, j: p.j > idx ? p.j - 1 : p.j }));

      // Cache cleanup: always drop the path; drop the hash only if no item still uses it.
      const hashStillUsed = this.items.some(i => i.hash === hash);
      try { await removeFromCache(path, hash, !hashStillUsed); } catch (e) { console.warn('cache cleanup failed', e); }

      this[recluster]();

      // Keep viewing the same set if it still exists (>2 imgs); otherwise fall back to
      // the top result (was a pair, or the set dropped below 2 members).
      if (survivingPaths.length) {
        const survivors = new Set(survivingPaths);
        const ng = this.groups.find(g => g.members.some(mi => survivors.has(this.items[mi].path)));
        this.selectedId = ng ? ng.id : (this.groups[0]?.id ?? null);
      } else {
        this.selectedId = this.groups[0]?.id ?? null;
      }
    };

    this[showKeyboardControls] = async () => {
      await alertDialog(`
        <div class="p">
          <div class="table-wrapper mb">
            <table class="full">
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
    };

    /*
      Init Props
    */
    this.scanning = false;
    this.progress = null;
    this.groups = [];
    this.lastScan = null;
    this.items = [];
  }

  /*
    Lifecycle Callbacks
  */
  // titlebar.html lives outside this component (injected into the same document by
  // kempo-app's shell), so it reaches us via a plain document-level CustomEvent
  // rather than a bubbling shadow-DOM event. The k-context elements wrap <id-app> in
  // the page, so we resolve them across the shadow boundary with closestAcrossShadow.
  connectedCallback() {
    super.connectedCallback();
    this[cfgEl] = getConfig(this);
    this[uiEl] = getUI(this);
    this[seedConfig]();
    // Seed the selection key so every later change is a context:set (not a one-off
    // context:create that the :set listeners would miss).
    if (this[uiEl] && !this[uiEl].has('selectedId')) this[uiEl].set('selectedId', null);
    this[cfgEl]?.addEventListener('context:set', this.onConfigChange);
    this[uiEl]?.addEventListener('context:set', this.onUIChange);
    document.addEventListener('menu-action', this.onMenuAction);
    document.addEventListener('keydown', this.onGlobalKeydown);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this[cfgEl]?.removeEventListener('context:set', this.onConfigChange);
    this[uiEl]?.removeEventListener('context:set', this.onUIChange);
    document.removeEventListener('menu-action', this.onMenuAction);
    document.removeEventListener('keydown', this.onGlobalKeydown);
  }

  /*
    Protected Members
  */
  // App-level config lives in the dup-config context; selection in the dup-ui context.
  get settings() { return this[cfgEl]?.get('settings') ?? { ...DEFAULT_SETTINGS }; }
  get thresholds() { return this[cfgEl]?.get('thresholds') ?? { ...DEFAULT_THRESHOLDS }; }
  get sources() { return this[cfgEl]?.get('sources') ?? { reference: [], search: [] }; }
  get selectedId() { return this[uiEl]?.get('selectedId') ?? null; }
  set selectedId(v) { this[uiEl]?.set('selectedId', v); }

  /*
    Public Methods
  */
  // Scan pipeline (cache-aware): resolve content hashes, compute/reuse features per
  // unique hash, geometrically verify candidate pairs, then cluster.
  async scan() {
    if (this.scanning) return;
    this.scanning = true;
    this[cancelRequested] = false;
    this.items = []; this[pairs] = []; this.groups = []; this.selectedId = null;
    this[orb].dispose();

    try {
      this[setProgress](0, 'Scanning folders…');
      // Scan each role separately, then merge by path into one list carrying ref/search
      // flags (an image reachable from both sets gets both). buildCandidatePairs uses
      // these to decide Reference×Search vs all-pairs.
      const opts = { recursive: this.settings.recursive };
      const [refFiles, searchFiles] = await Promise.all([
        api.scanImages(this.sources.reference, opts),
        api.scanImages(this.sources.search, opts)
      ]);
      const byPath = new Map();
      for (const f of searchFiles) byPath.set(f.path, { ...f, ref: false, search: true });
      for (const f of refFiles) {
        const ex = byPath.get(f.path);
        if (ex) ex.ref = true;
        else byPath.set(f.path, { ...f, ref: true, search: false });
      }
      const files = [...byPath.values()];
      if (!files.length) { this[setProgress](null); await alertDialog('No images found in the selected source(s).'); return; }

      const { useNN, usePhash, useGeo, preferGPU } = this.settings;
      const MODEL = useNN ? 'Xenova/dinov2-small' : 'phash-only';
      await initCache();

      // 1) Resolve content hashes — reuse cached hashes for unchanged paths.
      this[setProgress](0.02, 'Identifying files…');
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
          if (this[cancelRequested]) break;
          const slice = needHash.slice(i, i + HB);
          const ids = await api.fileIdentities(slice.map(f => f.path));
          ids.forEach((id, k) => { const f = slice[k]; if (id.hash) { f.hash = id.hash; newPathRows.push({ path: f.path, size: id.size, mtime: id.mtime, hash: id.hash }); } });
          this[setProgress](0.02 + 0.08 * (Math.min(i + HB, needHash.length) / needHash.length), `Identifying files… ${Math.min(i + HB, needHash.length)} / ${needHash.length}`);
        }
        await bulkUpsert('paths', ['path', 'size', 'mtime', 'hash'], newPathRows);
      }

      const items = files.filter(f => f.hash).map(f => ({ path: f.path, name: f.name, size: f.size, hash: f.hash, ref: !!f.ref, search: !!f.search, phash: null, embedding: null }));
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
          this[setProgress](0.1, 'Loading neural model (first run downloads it)…');
          const info = await api.initEngine({ preferGPU });
          if (info.ok) this[setProgress](0.12, `Model ready on ${String(info.device).toUpperCase()}.`);
          else console.warn('Engine init failed:', info.error);
        }
        const BATCH = 8, imgRows = [];
        for (let i = 0; i < missingHashes.length; i += BATCH) {
          if (this[cancelRequested]) break;
          const slice = missingHashes.slice(i, i + BATCH);
          const res = await api.embedImages(slice.map(h => repPath.get(h)), { useNN, usePhash });
          res.forEach((r, k) => {
            const h = slice[k];
            featByHash.set(h, { phash: r.phash || null, embedding: r.embedding || null });
            imgRows.push({ hash: h, phash: r.phash ? JSON.stringify(r.phash) : null, embedding: r.embedding ? embToB64(r.embedding) : null, model: MODEL, w: null, h: null });
          });
          this[setProgress](0.12 + 0.55 * (Math.min(i + BATCH, missingHashes.length) / missingHashes.length), `Analyzing new images… ${Math.min(i + BATCH, missingHashes.length)} / ${missingHashes.length}`);
        }
        await bulkUpsert('images', ['hash', 'phash', 'embedding', 'model', 'w', 'h'], imgRows);
      }

      for (const it of items) { const f = featByHash.get(it.hash); if (f) { it.phash = f.phash; it.embedding = f.embedding; } }
      this.items = items;
      const summary = { files: items.length, unique: uniqueHashes.length, newFeat: missingHashes.length, reusedFeat: uniqueHashes.length - missingHashes.length, newOrb: 0, reusedOrb: 0 };

      this[pairs] = buildCandidatePairs(this.items);

      // Load every user-confirmed not-duplicate pair (clusterPairs needs the full set to
      // catch transitive conflicts, not just direct candidate pairs — see its comment).
      // Drop directly-excluded candidate pairs now too, purely so ORB doesn't waste time
      // geometrically verifying a pair we already know must never link.
      this[excluded] = await getExcludedPairs();
      if (this[excluded].size) {
        const keyOf = p => pairKey(this.items[p.i].hash, this.items[p.j].hash);
        this[pairs] = this[pairs].filter(p => !this[excluded].has(keyOf(p)));
      }

      // 3) Geometric verification. The neural embedding only *finds candidates* here;
      //    grouping requires real copy evidence (ORB overlap or pHash) — see pairScore.
      //    Verify the most-similar candidate pairs first (highest embedding/pHash).
      if (useGeo && !this[cancelRequested]) {
        const ORB_CAP = 6000;
        const sim = p => Math.max(p.sEmbed, p.sPhash);
        const keyOf = p => pairKey(this.items[p.i].hash, this.items[p.j].hash);
        const border = this[pairs]
          .filter(p => this.items[p.i].hash !== this.items[p.j].hash && sim(p) >= 0.2)
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
            this[setProgress](0.7, 'Loading geometric matcher…');
            let cvOk = true;
            try { await this[orb].ensure(); } catch (e) { cvOk = false; console.warn('Geometric tier unavailable:', e.message); }
            if (cvOk) {
              const orbRows = [];
              let done = 0;
              await this[orb].matchAll(
                toCompute,
                job => [this.items[job.p.i].path, this.items[job.p.j].path],
                (_idx, orbScore, job) => {
                  if (orbScore != null) { job.p.sOrb = remapOrb(orbScore); orbRows.push({ pair: job.key, score: orbScore }); }
                  done++;
                  if (done % 5 === 0 || done === toCompute.length) this[setProgress](0.7 + 0.28 * (done / toCompute.length), `Verifying geometry… ${done} / ${toCompute.length} new`);
                },
                () => this[cancelRequested]
              );
              await bulkUpsert('orbcache', ['pair', 'score'], orbRows);
            }
          }
        }
      }
      this.lastScan = summary;

      this[setProgress](1, 'Clustering…');
      this[recluster]();
      this[setProgress](null);
      if (this[cancelRequested]) await alertDialog('Scan cancelled — showing results for what finished so far. Anything already analyzed stays cached.');
    } catch (e) {
      console.error(e); this[setProgress](null); await errorDialog('Scan failed: ' + (e?.message || e));
    } finally {
      this.scanning = false;
    }
  }

  /*
    Event Handlers
  */
  onMenuAction = e => {
    const { value } = e.detail;
    const controls = this.shadowRoot.querySelector('id-controls');
    if (value === 'add-folder') controls?.addFolderTo('both');
    else if (value === 'add-images') controls?.addImagesTo('both');
    else if (value === 'reload-app') location.reload();
    else if (value === 'clear-cache') this.onClearCache();
    else if (value === 'reset-settings') this.onResetSettings();
    else if (value === 'keyboard-controls') this[showKeyboardControls]();
  };

  // Re-cluster when a detection setting or threshold changes, and clear stale results
  // when a source is removed (the dup-config context is written by the controls pane).
  onConfigChange = e => {
    const { key, oldValue, value } = e.detail;
    if (key === 'sources') {
      const paths = src => [...(src?.reference || []), ...(src?.search || [])].map(s => s.path);
      const newPaths = new Set(paths(value));
      // A removed source means the current results were computed over images that may no
      // longer be in scope — clear them rather than showing stale results until rescan.
      if (paths(oldValue).some(p => !newPaths.has(p))) {
        document.querySelectorAll('k-photo-viewer[fullscreen]').forEach(v => v.close());
        this.items = []; this[pairs] = []; this.groups = []; this.lastScan = null; this.selectedId = null;
      }
    } else if ((key === 'settings' || key === 'thresholds') && this.items.length) {
      this[recluster]();
    }
  };

  onUIChange = e => { if (e.detail.key === 'selectedId') this.requestUpdate(); };

  // Enter opens the first photo of the selected dupe set, Delete runs Auto Delete on it,
  // Backspace runs Delete Selected, ` (or ~) runs Not Duplicates, and Up/Down move the
  // selection to the previous/next dupe set — but not while focus is on a
  // button/link/input/dialog, where those keys already do something else
  // (activate, submit, confirm, delete-current-photo).
  onGlobalKeydown = async e => {
    const isNav = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const isTilde = e.key === '~' || e.key === '`';
    if (e.key !== 'Enter' && e.key !== 'Delete' && e.key !== 'Backspace' && !isTilde && !isNav) return;
    const path = e.composedPath();
    const target = path[0];
    if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return;
    if (target?.isContentEditable) return;
    if (path.some(el => el?.tagName === 'K-DIALOG')) return;
    if (!this.groups.find(g => g.id === this.selectedId)) return;
    const detail = this.shadowRoot.querySelector('id-detail');
    const viewerOpen = !!document.querySelector('k-photo-viewer[fullscreen]');
    if (e.key === 'Enter') {
      detail?.openFirst();
    } else if (e.key === 'Delete') {
      // The Photo Viewer (if open) handles Delete itself — see DupDetail.js's wireViewerDelete.
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
      await this[syncViewerToSelection]();
    }
  };

  onStartScan = () => this.scan();
  onCancelScan = async () => {
    if (!this.scanning) return;
    const ok = await confirmDialog('Stop the current scan? Anything already analyzed stays cached, and you\'ll see results for whatever finished so far.', { title: 'Cancel Scan' });
    if (!ok) return;
    this[cancelRequested] = true;
  };
  onClearCache = async () => {
    const ok = await confirmDialog('Clear the cached hashes, features, comparisons and "not duplicate" marks? The next scan will recompute everything from scratch.', { title: 'Clear cache' });
    if (!ok) return;
    try {
      await clearCache();
      this[excluded] = new Set();
      if (this.items.length) this[recluster]();
      await alertDialog('Cache cleared.');
    } catch (e) { await errorDialog('Could not clear cache: ' + (e?.message || e)); }
  };

  onResetSettings = async () => {
    const ok = await confirmDialog('Reset all detection settings and thresholds back to their defaults?', { title: 'Reset settings' });
    if (!ok) return;
    // Writing to the config context re-renders the controls and triggers onConfigChange
    // (which reclusters if there are results).
    this[cfgEl]?.set('settings', { ...DEFAULT_SETTINGS });
    this[cfgEl]?.set('thresholds', { ...DEFAULT_THRESHOLDS });
    await alertDialog('Settings reset.');
  };

  onFileAction = async e => {
    const { action, path, onDone } = e.detail;
    if (action === 'trash') {
      if (this.settings.confirmDelete) {
        const ok = await confirmDialog(`<p class="p">Move this file to the Recycle Bin?<br><span class="small tc-muted">${path}</span></p>`,
          { title: 'Move to Trash', confirmText: 'Trash', confirmClasses: 'danger ml', cancelText: 'Cancel', cancelClasses: 'secondary' });
        if (!ok) { onDone?.(false); return; }
      }
      const r = await api.fileAction('trash', path);
      if (!r.ok) { await errorDialog('Could not delete the file: ' + (r.error || 'unknown error')); onDone?.(false); return; }
      await this[removeItem](path);
      onDone?.(true);
      return;
    }
    const r = await api.fileAction(action, path);
    if (r && r.ok === false) await errorDialog(`Could not ${action} the file: ` + (r.error || 'unknown error'));
  };

  onAutoDelete = async e => {
    const { keepName, deletePaths } = e.detail;
    await this[trashPaths](deletePaths, 'Auto Delete',
      `<p class="p">Keep <strong>${keepName}</strong> and move the other ${deletePaths.length} image(s) to the Recycle Bin?</p>`);
  };

  onDeleteSelected = async e => {
    const { paths } = e.detail;
    await this[trashPaths](paths, 'Delete Selected',
      `<p class="p">Move the selected ${paths.length} image(s) to the Recycle Bin?</p>`);
  };

  // Permanently record that these images aren't duplicates of each other, so future
  // scans never re-link or re-verify them — then reflect that immediately by dropping
  // their pairwise links from the current results, without needing a rescan.
  onNotDuplicates = async e => {
    const { paths } = e.detail;
    const hashes = [...new Set(paths.map(p => this.items.find(i => i.path === p)?.hash).filter(Boolean))];
    if (hashes.length < 2) return;

    await markNotDuplicates(hashes);

    // Reflect it immediately without a rescan — clusterPairs reads this set on every
    // recluster, so it'll keep these images apart (directly and transitively) from here on.
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) this[excluded].add(pairKey(hashes[i], hashes[j]));
    }
    // The marked set is gone for good (those members can never group together again),
    // so move to whatever now sits in the same list position rather than trying to
    // find "the same set" — and keep the Photo Viewer in sync if it's open.
    this[recluster]({ advance: true });
    await this[syncViewerToSelection]();
  };

  /*
    Rendering
  */
  render() {
    const selGroup = this.groups.find(g => g.id === this.selectedId) || null;
    return html`
      <k-split persistent-id="dup-outer" grip style="height:calc(100vh - var(--app-titlebar-height, 0px)); --pane_1_size:25%;">
        <id-controls
          .scanning=${this.scanning} .progress=${this.progress}
          @start-scan=${this.onStartScan} @cancel-scan=${this.onCancelScan} @clear-cache=${this.onClearCache}
          @reset-settings=${this.onResetSettings}></id-controls>

        <k-split slot="right" persistent-id="dup-inner" grip style="height:100%; --pane_1_size:33.333%;">
          <id-results
            .groups=${this.groups} .items=${this.items} .summary=${this.lastScan} .scanning=${this.scanning}></id-results>
          <id-detail slot="right"
            .group=${selGroup} .items=${this.items}
            @file-action=${this.onFileAction} @auto-delete=${this.onAutoDelete}
            @delete-selected=${this.onDeleteSelected} @not-duplicates=${this.onNotDuplicates}></id-detail>
        </k-split>
      </k-split>`;
  }

  static styles = [shared];
}

customElements.define('id-app', App);
