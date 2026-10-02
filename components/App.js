import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html } from '/modules/kempo-ui/dist/lit-all.min.js';
import Dialog from '/modules/kempo-ui/dist/components/Dialog.js';
import Toast from '/modules/kempo-ui/dist/components/Toast.js';
import { shared } from '/lib/styles.js';
import api from '/lib/api.js';
import { getConfig, getUI } from '/lib/contexts.js';
import './Controls.js';
import './Results.js';
import './Detail.js';
import {
  selectIn, bulkUpsert, embToB64, b64ToEmb, clearCache, clearExclusionsInSources, removeFromCache,
  buildCandidatePairs, clusterPairs, remapOrb, OrbMatcher, pairKey, markNotDuplicates, unmarkNotDuplicates,
  getExcludedPairs, migrateExcludedPairs, gcCache, DEFAULT_COHESION
} from '/lib/engine.js';

/*
  Utility Functions
*/
// kempo-ui Dialog wrapped as awaitable promises (no native alert/confirm).
const confirmDialog = (text, opts = {}) => new Promise(res => Dialog.confirm(text, res, opts));
const alertDialog = (text, opts = {}) => new Promise(res => Dialog.alert(text, res, opts));

const MODEL_NN = 'Xenova/dinov2-small';
const DEFAULT_SETTINGS = { recursive: true, usePhash: true, useNN: true, useGeo: true, useCopy: true, preferGPU: true, confirmDelete: true, maxGroupSize: 10, cohesion: DEFAULT_COHESION, orbFloor: 0, orbCap: 20000, thumbSize: 'medium', deprioritizeScreenshots: true, autoDeletePreview: true, actionHistoryLength: 100 };
// Per-tier match thresholds (%). Each tier's raw score is remapped (see lib/engine.js's
// remapEmbed/remapPhash/remapOrb) so 50% lands exactly on that tier's real decision
// boundary — the same default works for all three instead of needing separate tuning.
const DEFAULT_THRESHOLDS = { phash: 50, nn: 50, geo: 50, copy: 50 };

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
const rebuildPairs = Symbol('rebuildPairs');
const recluster = Symbol('recluster');
const syncViewerToSelection = Symbol('syncViewerToSelection');
const trashPaths = Symbol('trashPaths');
const removeItem = Symbol('removeItem');
const showKeyboardControls = Symbol('showKeyboardControls');
const undoStack = Symbol('undoStack');
const redoStack = Symbol('redoStack');
const pushHistoryEntry = Symbol('pushHistoryEntry');
const trimHistory = Symbol('trimHistory');
const finalizeHistoryEntry = Symbol('finalizeHistoryEntry');
const clearHistory = Symbol('clearHistory');
const pruneStaleNotDuplicateEntries = Symbol('pruneStaleNotDuplicateEntries');
const reinsertItems = Symbol('reinsertItems');

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
    items: { state: true },
    // Mirror of whether undoStack/redoStack have anything in them — plain arrays behind a
    // private symbol wouldn't trigger a re-render on push/pop, so these get reassigned
    // alongside every stack mutation purely so Detail's Undo/Redo buttons update.
    canUndo: { state: true },
    canRedo: { state: true }
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
    // Undo/redo history — see the entry-shape comment on pushHistoryEntry. In-memory only
    // (not persisted): it's meaningless across a reload anyway, since items/pairs/groups
    // are rebuilt from scratch then too.
    this[undoStack] = [];
    this[redoStack] = [];

    /*
      Private Methods
    */
    // First run (or a context with no persisted data yet): seed the config context with
    // defaults, migrating once from the pre-context localStorage key if it's there.
    this[seedConfig] = () => {
      const c = this[cfgEl];
      if (!c) return;
      // An existing config predates any setting added by a later version, and the getters
      // return the persisted object as-is — so a new key would read `undefined` forever:
      // its tier renders permanently off and its threshold arrives as NaN. Backfill only
      // the missing keys, leaving everything the user has chosen untouched.
      if (c.has('settings')) {
        const missing = (defaults, cur) => Object.keys(defaults).some(k => !(k in (cur || {})));
        const s = c.get('settings'), t = c.get('thresholds');
        if (missing(DEFAULT_SETTINGS, s)) c.set('settings', { ...DEFAULT_SETTINGS, ...s });
        if (missing(DEFAULT_THRESHOLDS, t)) c.set('thresholds', { ...DEFAULT_THRESHOLDS, ...t });
        return;
      }
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
    // across the slider's fractional value — rounded to 1 decimal place rather than a
    // whole number, since Geometric's slider moves in half-percent steps.
    this[clusterSettings] = () => {
      const t = this.thresholds;
      const round1 = n => Math.round(n * 10) / 10;
      return {
        ...this.settings,
        tPhash: round1(t.phash) / 100,
        tCopy: round1(t.copy) / 100,
        tNN: round1(t.nn) / 100,
        tGeo: round1(t.geo) / 100
      };
    };

    // Recompute this[pairs] from scratch and drop whatever this[excluded] currently
    // covers — the same two steps scan() runs right after buildCandidatePairs. Needed
    // any time this[excluded] shrinks (an exclusion gets lifted) rather than just
    // recluster()-ing: scan() already stripped every *then*-excluded pair out of
    // this[pairs] entirely (so ORB doesn't waste time verifying a pair that can never
    // link — see the comment where scan() does it), so a pair excluded before the last
    // scan isn't merely blocked, it's physically absent — recluster() alone can't bring
    // it back no matter how this[excluded] changes. A freshly-scanned pair (never
    // excluded, or excluded and un-excluded in the same session with no scan in between)
    // was never stripped, so this is a no-op difference for it either way.
    this[rebuildPairs] = () => {
      this[pairs] = buildCandidatePairs(this.items, this.settings);
      if (this[excluded].size) {
        const keyOf = p => pairKey(this.items[p.i].hash, this.items[p.j].hash);
        this[pairs] = this[pairs].filter(p => !this[excluded].has(keyOf(p)));
      }
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

      // One history entry for the whole batch (Auto Delete / Delete Selected undoes/redoes
      // together, matching the single user action it was) — pushed for whatever succeeded
      // even if a later file in the batch fails, so an early stop doesn't lose the undo.
      const done = [];
      for (const path of paths) {
        const item = this.items.find(i => i.path === path);
        const r = await api.fileAction('trash', path);
        if (!r.ok) { Toast.error('Could not delete the file: ' + (r.error || 'unknown error')); break; }
        done.push({ path, trashedPath: r.trashedPath || null, item });
        await this[removeItem](path);
      }
      if (done.length) this[pushHistoryEntry]({ type: 'trash', items: done });
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

    /*
      Undo/redo history. Two entry shapes:
        { type: 'trash', items: [{ path, trashedPath, item }] } — trashedPath is only ever
          set on macOS (see api/fileAction.js's app-managed trash); `item` is the exact
          object that was in this.items right before it was removed, kept so undo can
          splice it back with its cached phash/embedding/sscd intact, no rescan needed.
        { type: 'not-duplicate', hashes: [...] } — the content hashes marked as a group.
      A fresh user action pushes onto undoStack and drops (finalizing) whatever was on
      redoStack — the usual "a new edit clears redo" rule.
    */
    this[finalizeHistoryEntry] = entry => {
      if (entry?.type !== 'trash') return;
      // Only macOS's app-managed trash needs this — win/linux items just keep sitting in
      // the real Recycle Bin/Trash as always, nothing of ours to release.
      for (const it of entry.items) {
        if (it.trashedPath) api.fileAction('finalizeTrash', it.trashedPath).catch(() => {});
      }
    };

    this[trimHistory] = () => {
      const max = this.settings.actionHistoryLength || DEFAULT_SETTINGS.actionHistoryLength;
      while (this[undoStack].length > max) this[finalizeHistoryEntry](this[undoStack].shift());
      while (this[redoStack].length > max) this[finalizeHistoryEntry](this[redoStack].shift());
      this.canUndo = this[undoStack].length > 0;
      this.canRedo = this[redoStack].length > 0;
    };

    this[pushHistoryEntry] = entry => {
      this[redoStack].forEach(e => this[finalizeHistoryEntry](e));
      this[redoStack] = [];
      this[undoStack].push(entry);
      this[trimHistory]();
    };

    // Everything the stacks reference (item snapshots, pair indices) is about to be
    // invalidated wholesale — called wherever items/pairs get wiped and rebuilt from
    // scratch (a fresh scan, a source removed) or the DB decisions they'd redo/undo are
    // being wiped too (Clear cache).
    this[clearHistory] = () => {
      this[undoStack].forEach(e => this[finalizeHistoryEntry](e));
      this[redoStack].forEach(e => this[finalizeHistoryEntry](e));
      this[undoStack] = [];
      this[redoStack] = [];
      this.canUndo = false;
      this.canRedo = false;
    };

    // A scoped exclusion clear (onClearSourceCache) drops specific excluded_pairs rows
    // without touching the rest of the DB — unlike clearCache(), that's not sweeping
    // enough to justify wiping every trash entry too, only the 'not-duplicate' entries
    // whose own rows were among those just dropped (undoing/redoing one now would toggle
    // rows the DB no longer has any record of agreeing to either way).
    this[pruneStaleNotDuplicateEntries] = removedPairKeys => {
      if (!removedPairKeys?.length) return;
      const removed = new Set(removedPairKeys);
      const isStale = e => {
        if (e.type !== 'not-duplicate') return false;
        for (let i = 0; i < e.hashes.length; i++) {
          for (let j = i + 1; j < e.hashes.length; j++) {
            if (removed.has(pairKey(e.hashes[i], e.hashes[j]))) return true;
          }
        }
        return false;
      };
      this[undoStack] = this[undoStack].filter(e => !isStale(e));
      this[redoStack] = this[redoStack].filter(e => !isStale(e));
      this.canUndo = this[undoStack].length > 0;
      this.canRedo = this[redoStack].length > 0;
    };

    // Splice previously-removed item snapshots back into the live results (Undo of a
    // trash). Reuses buildCandidatePairs over the whole item list — the same pure,
    // synchronous math a scan already runs, just skipped for geometric verification (which
    // needs the ORB worker pool and real per-pair image comparison, not worth redoing
    // synchronously for an undo) — so a restored item's pairs read as "not yet
    // geometrically checked" exactly like right after a fresh scan and before ORB's pass;
    // a later rescan verifies it properly. Returns the snapshots actually spliced back in
    // (a path already present — e.g. the user manually restored it before hitting Undo —
    // is skipped rather than duplicated).
    this[reinsertItems] = snaps => {
      const existing = new Set(this.items.map(i => i.path));
      const fresh = snaps.filter(s => s && !existing.has(s.path));
      if (!fresh.length) return fresh;

      this.items = [...this.items, ...fresh];
      this[rebuildPairs]();
      this[recluster]();

      const freshPaths = new Set(fresh.map(s => s.path));
      const ng = this.groups.find(g => g.members.some(mi => freshPaths.has(this.items[mi].path)));
      if (ng) this.selectedId = ng.id;
      return fresh;
    };

    this[showKeyboardControls] = async () => {
      await alertDialog(`
        <div class="p">
          <div class="table-wrapper mb">
            <table class="full">
              <thead><tr><th>Key</th><th>When</th><th>Action</th></tr></thead>
              <tbody>
                <tr><td><strong>Up</strong> / <strong>Down</strong></td><td>Always</td><td>Select the previous/next dupe set (also updates the open Photo Viewer, if any)</td></tr>
                <tr><td><strong>Home</strong> / <strong>End</strong></td><td>Always</td><td>Select the first/last dupe set (also updates the open Photo Viewer, if any)</td></tr>
                <tr><td><strong>Enter</strong></td><td>Always</td><td>Open the first photo of the selected dupe set in the Photo Viewer</td></tr>
                <tr><td><strong>Delete</strong></td><td>Not in Photo Viewer</td><td>Auto Delete the selected dupe set</td></tr>
                <tr><td><strong>Backspace</strong></td><td>Always</td><td>Delete the checked images, if any are checked</td></tr>
                <tr><td><strong>&#96;</strong> / <strong>~</strong></td><td>Always</td><td>Mark the selected dupe set as Not Duplicates</td></tr>
                <tr><td><strong>Ctrl/Cmd + Z</strong></td><td>Always</td><td>Undo the last delete or Not Duplicates action</td></tr>
                <tr><td><strong>Ctrl/Cmd + Shift + Z</strong></td><td>Always</td><td>Redo the last undone action</td></tr>
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
    this.canUndo = false;
    this.canRedo = false;
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
    // Anything left in macOS's app-managed trash folder belongs to an undo history that
    // died with the last session (it's in-memory only) — hand it off to the real Trash
    // rather than let it sit there untracked forever. No-op on Windows/Linux.
    api.fileAction('sweepTrash').catch(() => {});
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
    this[clearHistory]();

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
      if (!files.length) { this[setProgress](null); Toast.warning('No images found in the selected source(s).'); return; }

      const { useNN, usePhash, useGeo, useCopy, preferGPU } = this.settings;
      const MODEL = useNN ? MODEL_NN : 'phash-only';
      // Tracked separately from MODEL so the two descriptor tiers' caches invalidate
      // independently — turning one on shouldn't discard the other's work.
      const SSCD_MODEL = 'sscd_disc_mixup';

      // 1) Resolve content hashes — reuse cached hashes for unchanged paths.
      this[setProgress](0.02, 'Identifying files…');
      const pathCache = await selectIn('paths', 'path,size,mtime,hash', 'path', files.map(f => f.path));
      const needHash = [];
      for (const f of files) {
        const c = pathCache.get(f.path);
        if (c && c.size === f.size && Math.abs(c.mtime - f.mtime) < 1 && c.hash) f.hash = c.hash;
        else needHash.push(f);
      }
      let migrated = 0;
      if (needHash.length) {
        const HB = 64, newPathRows = [];
        // Paths whose content changed under us — old hash kept so the user's
        // not-duplicate decisions can follow the file to its new identity.
        const rehashed = [];
        for (let i = 0; i < needHash.length; i += HB) {
          if (this[cancelRequested]) break;
          const slice = needHash.slice(i, i + HB);
          const ids = await api.fileIdentities(slice.map(f => f.path));
          ids.forEach((id, k) => {
            const f = slice[k];
            if (!id.hash) return;
            const prev = pathCache.get(f.path)?.hash;
            if (prev && prev !== id.hash) rehashed.push([prev, id.hash]);
            f.hash = id.hash;
            newPathRows.push({ path: f.path, size: id.size, mtime: id.mtime, hash: id.hash });
          });
          this[setProgress](0.02 + 0.08 * (Math.min(i + HB, needHash.length) / needHash.length), `Identifying files… ${Math.min(i + HB, needHash.length)} / ${needHash.length}`);
        }
        await bulkUpsert('paths', ['path', 'size', 'mtime', 'hash'], newPathRows);
        for (const [prev, next] of rehashed) {
          try { migrated += await migrateExcludedPairs(prev, next); }
          catch (e) { console.warn('exclusion migration failed', e); }
        }
      }
      // Sweep rows for hashes nothing points at anymore (what an external edit orphans).
      // Runs after paths are updated so the new identities already count as referenced.
      let collected = { images: 0, orb: 0 };
      try { collected = await gcCache(); } catch (e) { console.warn('cache gc failed', e); }

      const items = files.filter(f => f.hash).map(f => ({ path: f.path, name: f.name, size: f.size, hash: f.hash, ref: !!f.ref, search: !!f.search, phash: null, embedding: null, sscd: null }));
      const uniqueHashes = [...new Set(items.map(i => i.hash))];

      // 2) Features per unique hash — load from cache, compute only the misses.
      //    Validity is tracked per tier: the pHash/embedding pair is gated on `model`, the
      //    SSCD descriptor on `sscdModel`, so enabling one tier never discards the other's
      //    cached work.
      const featRows = await selectIn('images', 'hash,phash,embedding,model,sscd,sscdModel', 'hash', uniqueHashes);
      const featByHash = new Map();
      for (const h of uniqueHashes) {
        const r = featRows.get(h);
        if (!r) continue;
        const baseOk = r.model === MODEL_NN || r.model === MODEL;
        featByHash.set(h, {
          phash: baseOk && r.phash ? JSON.parse(r.phash) : null,
          embedding: r.model === MODEL_NN && r.embedding ? b64ToEmb(r.embedding) : null,
          sscd: r.sscdModel === SSCD_MODEL && r.sscd ? b64ToEmb(r.sscd) : null
        });
      }
      // A hash needs analysis when a tier the user has ENABLED has nothing cached for it.
      const missingHashes = uniqueHashes.filter(h => {
        const f = featByHash.get(h);
        if (!f) return true;
        return (usePhash && !f.phash) || (useNN && !f.embedding) || (useCopy && !f.sscd);
      });
      const repPath = new Map();
      for (const it of items) if (!repPath.has(it.hash)) repPath.set(it.hash, it.path);

      let copyReady = false;
      if (missingHashes.length) {
        if (useNN) {
          this[setProgress](0.1, 'Loading neural model (first run downloads it)…');
          const info = await api.initEngine({ preferGPU });
          if (info.ok) this[setProgress](0.12, `Model ready on ${String(info.device).toUpperCase()}.`);
          else console.warn('Engine init failed:', info.error);
        }
        if (useCopy) {
          this[setProgress](0.11, 'Loading copy-detection model…');
          const info = await api.initSscd();
          copyReady = !!info.ok;
          if (!copyReady) console.warn('Copy-detection tier unavailable:', info.error);
        }
        const BATCH = 8, imgRows = [];
        for (let i = 0; i < missingHashes.length; i += BATCH) {
          if (this[cancelRequested]) break;
          const slice = missingHashes.slice(i, i + BATCH);
          const res = await api.embedImages(slice.map(h => repPath.get(h)), { useNN, usePhash, useCopy: copyReady });
          res.forEach((r, k) => {
            const h = slice[k];
            // Merge over whatever was already cached: bulkUpsert does INSERT OR REPLACE, so
            // writing only the freshly-computed tier would blank the others.
            const prev = featByHash.get(h) || {};
            const merged = {
              phash: r.phash || prev.phash || null,
              embedding: r.embedding || prev.embedding || null,
              sscd: r.sscd || prev.sscd || null
            };
            featByHash.set(h, merged);
            imgRows.push({
              hash: h,
              phash: merged.phash ? JSON.stringify(merged.phash) : null,
              embedding: merged.embedding ? embToB64(merged.embedding) : null,
              // `model` describes what embedding is actually stored, so a pHash-only scan
              // can't mislabel a row that still carries a real neural embedding.
              model: merged.embedding ? MODEL_NN : 'phash-only',
              sscd: merged.sscd ? embToB64(merged.sscd) : null,
              sscdModel: merged.sscd ? SSCD_MODEL : null,
              w: null, h: null
            });
          });
          this[setProgress](0.12 + 0.55 * (Math.min(i + BATCH, missingHashes.length) / missingHashes.length), `Analyzing new images… ${Math.min(i + BATCH, missingHashes.length)} / ${missingHashes.length}`);
        }
        await bulkUpsert('images', ['hash', 'phash', 'embedding', 'model', 'sscd', 'sscdModel', 'w', 'h'], imgRows);
      }

      for (const it of items) { const f = featByHash.get(it.hash); if (f) { it.phash = f.phash; it.embedding = f.embedding; it.sscd = f.sscd; } }
      this.items = items;
      // Recorded so a later settings change can tell whether a now-enabled tier was
      // actually analyzed this scan (onConfigChange uses it to offer a rescan).
      const summary = {
        files: items.length, unique: uniqueHashes.length, newFeat: missingHashes.length,
        migratedExclusions: migrated, gcImages: collected.images, gcOrb: collected.orb,
        reusedFeat: uniqueHashes.length - missingHashes.length, newOrb: 0, reusedOrb: 0,
        computedTiers: { usePhash, useNN, useGeo, useCopy: useCopy && copyReady }
      };

      // Load every user-confirmed not-duplicate pair (clusterPairs needs the full set to
      // catch transitive conflicts, not just direct candidate pairs — see its comment)
      // before building candidates, so rebuildPairs's own filter drops directly-excluded
      // pairs immediately — purely so ORB doesn't waste time geometrically verifying a
      // pair we already know must never link.
      this[excluded] = await getExcludedPairs();
      this[rebuildPairs]();

      // 3) Geometric verification. The neural embedding only *finds candidates* here;
      //    grouping requires real copy evidence (ORB overlap or pHash) — see pairScore.
      //    Verify the most-similar candidate pairs first (highest embedding/pHash) — unless
      //    neither ran, in which case there's no similarity to sort by, so every pair goes
      //    through (Geometric is solo: it's the only signal that gets to decide a match).
      if (useGeo && !this[cancelRequested]) {
        // Geometric verification is the tier that survives crops and rotations, so gating
        // it behind a *cheap-tier* score is self-defeating: the pairs it would rescue are
        // exactly the ones pHash/neural score low. The floor now defaults to 0, letting
        // every candidate pair through, with orbCap as the only budget limit (pairs are
        // ranked by cheap similarity so the cap sheds the least-promising ones first).
        const { orbFloor = 0, orbCap = 20000 } = this.settings;
        const cheapSignal = usePhash || useNN;
        const sim = p => Math.max(p.sEmbed, p.sPhash);
        const keyOf = p => pairKey(this.items[p.i].hash, this.items[p.j].hash);
        const border = this[pairs]
          .filter(p => this.items[p.i].hash !== this.items[p.j].hash && (!cheapSignal || sim(p) >= orbFloor))
          .sort((a, b) => sim(b) - sim(a))
          .slice(0, orbCap);
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
      if (this[cancelRequested]) Toast.create('Scan cancelled — showing results for what finished so far. Anything already analyzed stays cached.');
    } catch (e) {
      console.error(e); this[setProgress](null); Toast.error('Scan failed: ' + (e?.message || e));
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
  // Turning a tier back on doesn't make it analyze anything by itself — its
  // phash/embedding/ORB data is simply missing from the last scan's results — so
  // offer a rescan whenever a tier flips on that the last scan didn't actually compute.
  onConfigChange = async e => {
    const { key, oldValue, value } = e.detail;
    if (key === 'sources') {
      const paths = src => [...(src?.reference || []), ...(src?.search || [])].map(s => s.path);
      const newPaths = new Set(paths(value));
      // A removed source means the current results were computed over images that may no
      // longer be in scope — clear them rather than showing stale results until rescan.
      if (paths(oldValue).some(p => !newPaths.has(p))) {
        document.querySelectorAll('k-photo-viewer[fullscreen]').forEach(v => v.close());
        this.items = []; this[pairs] = []; this.groups = []; this.lastScan = null; this.selectedId = null;
        this[clearHistory]();
      }
    } else if (key === 'settings') {
      const computed = this.lastScan?.computedTiers;
      if (computed && this.items.length) {
        const TIER_LABELS = { usePhash: 'Perceptual hash', useNN: 'Neural look-alikes', useGeo: 'Geometric (ORB)', useCopy: 'Copy detection' };
        const newlyEnabled = Object.keys(TIER_LABELS).filter(k => value[k] && !oldValue[k] && !computed[k]);
        if (newlyEnabled.length) {
          const names = newlyEnabled.map(k => TIER_LABELS[k]);
          const ok = await confirmDialog(
            `<p class="p">${names.join(' and ')} ${names.length > 1 ? "weren't" : "wasn't"} analyzed in the last scan, ` +
            `so turning it on alone won't find anything for it. Rescan now?</p>`,
            { title: 'Rescan needed', confirmText: 'Rescan', cancelText: 'Not now' });
          if (ok) { this.scan(); return; }
        }
      }
      if (this.items.length) this[recluster]();
      // A shorter history length than before means evicting (and, on macOS, finalizing)
      // whatever now falls outside it.
      this[trimHistory]();
    } else if (key === 'thresholds' && this.items.length) {
      this[recluster]();
    }
  };

  onUIChange = e => { if (e.detail.key === 'selectedId') this.requestUpdate(); };

  // Enter opens the first photo of the selected dupe set, Delete runs Auto Delete on it,
  // Backspace runs Delete Selected, ` (or ~) runs Not Duplicates, Up/Down move the
  // selection to the previous/next dupe set, Home/End jump to the first/last dupe set, and
  // Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z undo/redo the last such action — but not while focus is
  // on a button/link/input/dialog, where those keys already do something else (activate,
  // submit, confirm, delete-current-photo, the browser's own text-field undo).
  onGlobalKeydown = async e => {
    const isNav = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End';
    const isTilde = e.key === '~' || e.key === '`';
    const isZ = (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z');
    const isUndo = isZ && !e.shiftKey;
    const isRedo = isZ && e.shiftKey;
    if (e.key !== 'Enter' && e.key !== 'Delete' && e.key !== 'Backspace' && !isTilde && !isNav && !isZ) return;
    const path = e.composedPath();
    const target = path[0];
    if (['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName)) return;
    if (target?.isContentEditable) return;
    if (path.some(el => el?.tagName === 'K-DIALOG')) return;
    if (isUndo) { e.preventDefault(); this.onUndo(); return; }
    if (isRedo) { e.preventDefault(); this.onRedo(); return; }
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
      let nextIdx;
      if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = this.groups.length - 1;
      else {
        const idx = this.groups.findIndex(g => g.id === this.selectedId);
        nextIdx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
      }
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
      // "Not duplicate" marks are part of what just got wiped, and a trashed file's
      // history entry can't undo anything the DB no longer remembers agreeing to either way.
      this[clearHistory]();
      // Every exclusion just disappeared, including ones the last scan had already
      // stripped straight out of this[pairs] (see rebuildPairs's comment) — recluster()
      // alone wouldn't bring those candidate pairs back.
      if (this.items.length) { this[rebuildPairs](); this[recluster](); }
      Toast.success('Cache cleared.');
    } catch (e) { Toast.error('Could not clear cache: ' + (e?.message || e)); }
  };

  // Scoped sibling of onClearCache — only drops "Not Duplicate" marks touching an image
  // under the *currently configured* Reference/Search sources, leaving marks for folders
  // no longer in scope (and every other cache table) untouched. Reflected immediately, no
  // rescan needed — same as onNotDuplicates/onClearCache.
  onClearSourceCache = async () => {
    const list = [...this.sources.reference, ...this.sources.search];
    if (!list.length) { Toast.warning('Add a Reference or Search folder first.'); return; }
    const ok = await confirmDialog(
      '<p class="p">Clear "Not Duplicate" marks for images in your current Reference and Search folders? ' +
      'Cached hashes and analysis stay put — only those marks are dropped, and only for folders you\'re ' +
      'currently working in.</p>',
      { title: 'Clear Folder Cache', width: '28rem' });
    if (!ok) return;
    try {
      const removed = await clearExclusionsInSources(list);
      for (const p of removed) this[excluded].delete(p);
      this[pruneStaleNotDuplicateEntries](removed);
      // A lifted exclusion may have been in place since before the last scan, which
      // strips a then-excluded pair out of this[pairs] entirely — see rebuildPairs.
      if (this.items.length) { this[rebuildPairs](); this[recluster](); }
      Toast.success(removed.length
        ? `Cleared ${removed.length} "Not Duplicate" mark${removed.length === 1 ? '' : 's'}.`
        : 'No "Not Duplicate" marks found in the current folders.');
    } catch (e) { Toast.error('Could not clear folder cache: ' + (e?.message || e)); }
  };

  onResetSettings = async () => {
    const ok = await confirmDialog('Reset all detection settings and thresholds back to their defaults?', { title: 'Reset settings' });
    if (!ok) return;
    // Writing to the config context re-renders the controls and triggers onConfigChange
    // (which reclusters if there are results).
    this[cfgEl]?.set('settings', { ...DEFAULT_SETTINGS });
    this[cfgEl]?.set('thresholds', { ...DEFAULT_THRESHOLDS });
    Toast.success('Settings reset.');
  };

  onFileAction = async e => {
    const { action, path, onDone } = e.detail;
    if (action === 'trash') {
      if (this.settings.confirmDelete) {
        const ok = await confirmDialog(`<p class="p">Move this file to the Recycle Bin?<br><span class="small tc-muted">${path}</span></p>`,
          { title: 'Move to Trash', confirmText: 'Trash', confirmClasses: 'danger ml', cancelText: 'Cancel', cancelClasses: 'secondary' });
        if (!ok) { onDone?.(false); return; }
      }
      const item = this.items.find(i => i.path === path);
      const r = await api.fileAction('trash', path);
      if (!r.ok) { Toast.error('Could not delete the file: ' + (r.error || 'unknown error')); onDone?.(false); return; }
      await this[removeItem](path);
      this[pushHistoryEntry]({ type: 'trash', items: [{ path, trashedPath: r.trashedPath || null, item }] });
      onDone?.(true);
      return;
    }
    const r = await api.fileAction(action, path);
    if (r && r.ok === false) Toast.error(`Could not ${action} the file: ` + (r.error || 'unknown error'));
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
    this[pushHistoryEntry]({ type: 'not-duplicate', hashes });
    // The marked set is gone for good (those members can never group together again),
    // so move to whatever now sits in the same list position rather than trying to
    // find "the same set" — and keep the Photo Viewer in sync if it's open.
    this[recluster]({ advance: true });
    await this[syncViewerToSelection]();
  };

  // Undo the most recent trash or Not Duplicates action. A trash undo restores the
  // physical file (Recycle Bin on Windows/Linux, our own app trash on macOS — see
  // api/fileAction.js) and splices its snapshot back into the live results; a Not
  // Duplicates undo just drops the exclusion rows it added. Reported failures (the file's
  // no longer in the Recycle Bin, something now already sits at its original path) leave
  // the rest of the app state untouched rather than half-applying the undo.
  onUndo = async () => {
    const entry = this[undoStack].pop();
    this.canUndo = this[undoStack].length > 0;
    if (!entry) return;

    if (entry.type === 'trash') {
      const restored = [], failed = [];
      for (const it of entry.items) {
        const r = await api.fileAction('restore', it.path, it.trashedPath);
        if (r?.ok) restored.push(it); else failed.push(r?.error);
      }
      if (restored.length) this[reinsertItems](restored.map(it => it.item));
      if (failed.length) {
        Toast.error(failed.length === entry.items.length
          ? `Could not undo: ${failed[0] || 'the file is no longer available to restore.'}`
          : `Restored ${restored.length} of ${entry.items.length} file(s) — ${failed.length} could not be recovered.`);
      }
      if (restored.length) { this[redoStack].push({ type: 'trash', items: restored }); this[trimHistory](); }
    } else if (entry.type === 'not-duplicate') {
      await unmarkNotDuplicates(entry.hashes);
      for (let i = 0; i < entry.hashes.length; i++) {
        for (let j = i + 1; j < entry.hashes.length; j++) this[excluded].delete(pairKey(entry.hashes[i], entry.hashes[j]));
      }
      this[recluster]();
      const hset = new Set(entry.hashes);
      const ng = this.groups.find(g => g.members.some(mi => hset.has(this.items[mi].hash)));
      if (ng) this.selectedId = ng.id;
      this[redoStack].push(entry);
      this[trimHistory]();
    }
    this.canRedo = this[redoStack].length > 0;
  };

  // Redo re-applies whatever Undo just reverted: re-trashes the same file(s) (a fresh
  // Recycle Bin / app-trash entry — the old trashedPath is gone once restored), or
  // re-marks the same hashes as Not Duplicates.
  onRedo = async () => {
    const entry = this[redoStack].pop();
    this.canRedo = this[redoStack].length > 0;
    if (!entry) return;

    if (entry.type === 'trash') {
      const done = [];
      for (const it of entry.items) {
        if (!this.items.some(i => i.path === it.path)) continue; // no longer present somehow
        const r = await api.fileAction('trash', it.path);
        if (!r.ok) { Toast.error('Could not redo delete: ' + (r.error || 'unknown error')); continue; }
        done.push({ path: it.path, trashedPath: r.trashedPath || null, item: it.item });
        await this[removeItem](it.path);
      }
      if (done.length) { this[undoStack].push({ type: 'trash', items: done }); this[trimHistory](); }
    } else if (entry.type === 'not-duplicate') {
      await markNotDuplicates(entry.hashes);
      for (let i = 0; i < entry.hashes.length; i++) {
        for (let j = i + 1; j < entry.hashes.length; j++) this[excluded].add(pairKey(entry.hashes[i], entry.hashes[j]));
      }
      this[recluster]({ advance: true });
      await this[syncViewerToSelection]();
      this[undoStack].push(entry);
      this[trimHistory]();
    }
    this.canUndo = this[undoStack].length > 0;
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
          @clear-source-cache=${this.onClearSourceCache} @reset-settings=${this.onResetSettings}></id-controls>

        <k-split slot="right" persistent-id="dup-inner" grip style="height:100%; --pane_1_size:33.333%;">
          <id-results
            .groups=${this.groups} .items=${this.items} .summary=${this.lastScan} .scanning=${this.scanning}></id-results>
          <id-detail slot="right"
            .group=${selGroup} .items=${this.items} .canUndo=${this.canUndo} .canRedo=${this.canRedo}
            @file-action=${this.onFileAction} @auto-delete=${this.onAutoDelete}
            @delete-selected=${this.onDeleteSelected} @not-duplicates=${this.onNotDuplicates}
            @undo=${this.onUndo} @redo=${this.onRedo}></id-detail>
        </k-split>
      </k-split>`;
  }

  static styles = [shared];
}

customElements.define('id-app', App);
