import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import PhotoViewer from '/modules/kempo-ui/dist/components/PhotoViewer.js';
import { shared } from '/lib/styles.js';
import { thumbnail, fmtBytes } from '/lib/engine.js';
import { getConfig } from '/lib/contexts.js';
import CompareViewer from './CompareViewer.js';
import './ImageCard.js';
import './Scores.js';

/*
  Utility Functions
*/
// Preference order for "most lossless" when resolution ties — lower index wins.
const FORMAT_PRIORITY = ['png', 'tiff', 'tif', 'bmp', 'webp', 'jpg', 'jpeg', 'gif'];
const formatRank = name => {
  const idx = FORMAT_PRIORITY.indexOf((name.split('.').pop() || '').toLowerCase());
  return idx === -1 ? FORMAT_PRIORITY.length : idx;
};
// Screenshots are often higher-resolution than the original (the device they were
// taken on outscales the source), which would otherwise win the "keep" slot on
// resolution alone — this catches that before resolution is even compared.
const isScreenshot = name => /screenshot/i.test(name);
// OS-generated duplicate copies get a marker appended before the extension — a
// "(1)", "(2)", etc. from Chrome re-downloads or Windows' "keep both files" prompt,
// or a "- Copy" / "- Copy (2)" from Windows Explorer's own Ctrl+C/Ctrl+V. These are
// almost always byte-identical to the file they were copied from, so resolution,
// format, and file size won't tell the two apart — this is checked only as a last
// tiebreak, ahead of the plain alphabetical compare, which would otherwise favor the
// suffixed copy (a space sorts before a dot, so "photo (1).jpg" < "photo.jpg").
const hasCopySuffix = name => {
  const base = name.replace(/\.[^./\\]+$/, '').trim();
  return /\(\d+\)$/.test(base) || /-\s*copy(\s*\(\d+\))?$/i.test(base);
};

const TILE_SIZES = { small: 220, medium: 320, large: 420 };

/*
  Symbols
*/
const cfg = Symbol('cfg');
const selKey = Symbol('selKey');
const previewKey = Symbol('previewKey');
const act = Symbol('act');
const triggerUndo = Symbol('triggerUndo');
const triggerRedo = Symbol('triggerRedo');
const setThumbSize = Symbol('setThumbSize');
const orderedMembers = Symbol('orderedMembers');
const openViewer = Symbol('openViewer');
const wireViewerDelete = Symbol('wireViewerDelete');
const rankGroup = Symbol('rankGroup');
const autoDelete = Symbol('autoDelete');
const updatePreview = Symbol('updatePreview');
const toggleSelect = Symbol('toggleSelect');
const deleteSelected = Symbol('deleteSelected');
const notDuplicates = Symbol('notDuplicates');
const compareEnabled = Symbol('compareEnabled');
const compareSelected = Symbol('compareSelected');

export default class Detail extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    group: { type: Object },
    items: { type: Array },
    selected: { type: Object },
    keeperPath: { state: true },
    // Owned by App (the undo/redo stacks live there, shared across the whole app rather
    // than scoped to whichever set happens to be selected), just passed down to drive the
    // toolbar buttons' disabled state.
    canUndo: { type: Boolean },
    canRedo: { type: Boolean }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Members
    */
    // Member paths of the set the checkbox selection belongs to — so a recluster that
    // only reorders/rescores the same members keeps the checkboxes.
    this[selKey] = '';
    // Same idea for the Auto Delete preview: the key of the group `updatePreview` is
    // currently computing, so a stale in-flight computation (group switched again
    // before its thumbnails resolved) never overwrites a newer one's result.
    this[previewKey] = '';
    this[cfg] = null; // dup-config context, resolved on connect

    /*
      Private Methods
    */
    this[act] = (action, path, onDone) => this.dispatchEvent(new CustomEvent('file-action', { detail: { action, path, onDone }, bubbles: true, composed: true }));

    this[triggerUndo] = () => { if (this.canUndo) this.dispatchEvent(new CustomEvent('undo', { bubbles: true, composed: true })); };
    this[triggerRedo] = () => { if (this.canRedo) this.dispatchEvent(new CustomEvent('redo', { bubbles: true, composed: true })); };

    this[setThumbSize] = value => this[cfg]?.set('settings', { ...this.settings, thumbSize: value });

    // Reference images first (stable sort, so everything else keeps its existing order),
    // so the known-good image is consistently the first tile and first photo in the viewer.
    this[orderedMembers] = () => [...this.group.members].sort((a, b) => (this.items[b]?.ref ? 1 : 0) - (this.items[a]?.ref ? 1 : 0));

    // Open every image in the current set as a scrollable fullscreen gallery, starting on the clicked one.
    this[openViewer] = async startIndex => {
      if (!this.group) return;
      // Close any gallery already open (e.g. the Up/Down shortcut switching dupe sets
      // while viewing one) so they don't stack — each .close() tears its own container down.
      document.querySelectorAll('k-photo-viewer[fullscreen]').forEach(v => v.close());
      const members = this[orderedMembers]();
      const paths = members.map(mi => this.items[mi].path);
      const content = await Promise.all(members.map(async mi => {
        const it = this.items[mi];
        const t = await thumbnail(it.path, 1600);
        return {
          src: t?.dataUrl || '',
          alt: it.name,
          caption: `<strong>${it.name}</strong><div class="tc-muted">${t?.width ? `${t.width} × ${t.height}` : '—'} &middot; ${fmtBytes(it.size)}</div>`
        };
      }));
      this[wireViewerDelete](PhotoViewer.open(content, startIndex), paths);
    };

    // While the fullscreen gallery is open, Delete removes whichever photo is
    // currently shown (respecting confirmDelete) and closes the viewer — the
    // underlying group is about to change anyway once the item is removed.
    this[wireViewerDelete] = (opened, paths) => {
      const viewers = Array.from(opened.parentElement.querySelectorAll('k-photo-viewer'));

      const onKeydown = e => {
        if (e.key !== 'Delete') return;
        const current = viewers.find(v => v.fullscreen);
        if (!current) return;
        const path = paths[viewers.indexOf(current)];
        if (!path) return;
        e.preventDefault();
        this[act]('trash', path, deleted => { if (deleted) current.close(); });
      };

      document.addEventListener('keydown', onKeydown);
      const cleanup = () => {
        if (!viewers.some(v => v.fullscreen)) {
          document.removeEventListener('keydown', onKeydown);
          viewers.forEach(v => v.removeEventListener('fullscreenclose', cleanup));
        }
      };
      viewers.forEach(v => v.addEventListener('fullscreenclose', cleanup));
    };

    // Rank a group's members best-keeper-first: highest resolution (ties broken by most-lossless
    // format, then smallest file size, then a "(1)"/"- Copy"-style name deprioritized, then
    // alphabetically). Unless disabled, a screenshot loses to any non-screenshot regardless of
    // resolution — see isScreenshot's comment. Shared by the Auto Delete action itself and the
    // grid's live "who would win" preview, so both always agree.
    this[rankGroup] = async g => {
      const deprioritizeScreenshots = this.settings.deprioritizeScreenshots;

      return (await Promise.all(g.members.map(async mi => {
        const it = this.items[mi];
        const t = await thumbnail(it.path, 480);
        return { path: it.path, name: it.name, size: it.size, area: (t?.width && t?.height) ? t.width * t.height : 0 };
      }))).sort((a, b) => {
        if (deprioritizeScreenshots) {
          const sa = isScreenshot(a.name), sb = isScreenshot(b.name);
          if (sa !== sb) return sa ? 1 : -1;
        }
        if (b.area !== a.area) return b.area - a.area;
        const fa = formatRank(a.name), fb = formatRank(b.name);
        if (fa !== fb) return fa - fb;
        if (a.size !== b.size) return a.size - b.size;
        const ca = hasCopySuffix(a.name), cb = hasCopySuffix(b.name);
        if (ca !== cb) return ca ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    };

    this[autoDelete] = async () => {
      const g = this.group;
      if (!g || g.members.length < 2) return;
      const [keep, ...rest] = await this[rankGroup](g);
      this.dispatchEvent(new CustomEvent('auto-delete', {
        detail: { keepPath: keep.path, keepName: keep.name, deletePaths: rest.map(d => d.path) },
        bubbles: true, composed: true
      }));
    };

    // Recompute which member Auto Delete would keep, so the grid can outline it in green
    // (and the rest in red) before the user commits to anything. Re-entrant: if the group
    // or settings change again before thumbnails resolve, the stale result is discarded
    // via previewKey rather than clobbering the newer one.
    this[updatePreview] = async () => {
      const g = this.group;
      if (!g || g.members.length < 2 || !this.settings.autoDeletePreview) { this[previewKey] = ''; this.keeperPath = null; return; }
      const key = g.members.map(mi => this.items[mi]?.path).join('|');
      // A genuinely new set of members: drop the old keeper now rather than let it
      // briefly point at a path that isn't even in this group (which would flash
      // every card red until the new ranking resolves).
      if (key !== this[previewKey]) this.keeperPath = null;
      this[previewKey] = key;
      const [keep] = await this[rankGroup](g);
      if (this[previewKey] !== key) return; // superseded by a newer group/settings change
      this.keeperPath = keep.path;
    };

    this[toggleSelect] = (path, checked) => {
      const next = new Set(this.selected);
      if (checked) next.add(path); else next.delete(path);
      this.selected = next;
    };

    this[deleteSelected] = () => {
      if (!this.selected.size) return;
      const paths = [...this.selected];
      this.selected = new Set();
      this.dispatchEvent(new CustomEvent('delete-selected', { detail: { paths }, bubbles: true, composed: true }));
    };

    // With nothing checked, flag every image in the whole set as not-duplicates of
    // each other; with 2+ checked, scope it to just those.
    this[notDuplicates] = () => {
      const g = this.group;
      const paths = this.selected.size >= 2 ? [...this.selected]
        : g ? g.members.map(mi => this.items[mi].path)
        : null;
      if (!paths || paths.length < 2) return;
      this.selected = new Set();
      this.dispatchEvent(new CustomEvent('not-duplicates', { detail: { paths }, bubbles: true, composed: true }));
    };

    // Two images are unambiguous to compare even with nothing checked.
    this[compareEnabled] = () => this.selected.size === 2 || (this.group && this.group.members.length === 2);

    // Side-by-side wipe compare of the two selected images (or the set's only two
    // images, when there's nothing else it could mean), for spotting small
    // differences (e.g. a wink) between near-identical shots.
    this[compareSelected] = async () => {
      const paths = this.selected.size === 2 ? [...this.selected]
        : this.group && this.group.members.length === 2 ? this.group.members.map(mi => this.items[mi].path)
        : null;
      if (!paths) return;
      const [a, b] = await Promise.all(paths.map(async p => {
        const it = this.items.find(i => i.path === p);
        const t = await thumbnail(it.path, 1600);
        return { name: it.name, src: t?.dataUrl || '', w: t?.width || 0, h: t?.height || 0 };
      }));
      CompareViewer.open({
        leftSrc: a.src, leftLabel: a.name,
        rightSrc: b.src, rightLabel: b.name,
        frameW: Math.max(a.w, b.w), frameH: Math.max(a.h, b.h)
      });
    };

    /*
      Init Props
    */
    this.group = null;
    this.items = [];
    this.selected = new Set();
    this.keeperPath = null;
    this.canUndo = false;
    this.canRedo = false;
  }

  /*
    Lifecycle Callbacks
  */
  connectedCallback() {
    super.connectedCallback();
    this[cfg] = getConfig(this);
    this[cfg]?.addEventListener('context:set', this.onConfigChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this[cfg]?.removeEventListener('context:set', this.onConfigChange);
  }

  // Clear the checkbox selection whenever the actual set of members changes (not on
  // every recluster — same members just get reordered/rescored). Each id-image-card
  // loads its own thumbnail. Also kicks off the Auto Delete preview for the (possibly new) group.
  updated(changedProperties) {
    if (changedProperties.has('group')) {
      const key = this.group ? this.group.members.map(mi => this.items[mi]?.path).join('|') : '';
      if (key !== this[selKey]) this.selected = new Set();
      this[selKey] = key;
      this[updatePreview]();
    }
  }

  /*
    Protected Members
  */
  get settings() { return this[cfg]?.get('settings') ?? { thumbSize: 'medium', deprioritizeScreenshots: true, autoDeletePreview: true }; }

  /*
    Event Handlers
  */
  // A settings change (e.g. toggling "deprioritize screenshots") doesn't touch the group
  // property, so updated() won't recompute the preview on its own — nudge it here too.
  onConfigChange = e => { if (e.detail.key === 'settings') { this.requestUpdate(); this[updatePreview](); } };
  // The card knows only its path; map it back to a position in the ordered members
  // to open the gallery on the right photo.
  onCardView = e => {
    const idx = this[orderedMembers]().findIndex(mi => this.items[mi].path === e.detail.path);
    if (idx !== -1) this[openViewer](idx);
  };
  onCardToggle = e => this[toggleSelect](e.detail.path, e.detail.checked);

  /*
    Public Methods
  */
  // Global "Enter" shortcut entry point — opens the first photo of whatever set is selected.
  openFirst() { this[openViewer](0); }

  // Global "Delete" shortcut entry point (when the Photo Viewer is closed) — same as
  // clicking the Auto Delete button.
  triggerAutoDelete() { this[autoDelete](); }

  // Global "~" shortcut entry point — same as clicking the Not Duplicates button.
  triggerNotDuplicates() { this[notDuplicates](); }

  // Global "Backspace" shortcut entry point — same as clicking Delete Selected
  // (a no-op if nothing's checked, just like the button being disabled).
  triggerDeleteSelected() { this[deleteSelected](); }

  /*
    Rendering
  */
  render() {
    const g = this.group;
    // Undo/Redo live in this row (not gated behind a selected group) because the action
    // they'd undo is often the very thing that just emptied the selection — e.g. the last
    // dupe set in the list just got Auto Deleted or dismissed as Not Duplicates.
    return html`
      <div class="pane">
        <div class="row ai-c ${g ? 'bb pb mb' : 'mb'}">
          <button class="mrh pxh" ?disabled=${!this.canUndo} title="Undo (Ctrl+Z)" @click=${() => this[triggerUndo]()}>
            <k-icon name="undo"></k-icon>
          </button>
          <button class="${g ? 'mrh' : ''} pxh" ?disabled=${!this.canRedo} title="Redo (Ctrl+Shift+Z)" @click=${() => this[triggerRedo]()}>
            <k-icon name="redo"></k-icon>
          </button>
          ${!g ? '' : html`
            <button class="danger mrh" @click=${() => this[autoDelete]()}><k-icon name="delete_auto"></k-icon> Auto Delete</button>
            <button class="danger mrh" ?disabled=${this.selected.size === 0} @click=${() => this[deleteSelected]()}>
              <k-icon name="delete_sweep"></k-icon> Delete Selected
            </button>
            <button class="mrh" ?disabled=${!this[compareEnabled]()} @click=${() => this[compareSelected]()}>
              <k-icon name="compare_arrows"></k-icon> Compare
            </button>
            <button @click=${() => this[notDuplicates]()}>
              <b>≠</b> Not Duplicates
            </button>
            <span class="col"></span>
            <div class="btn-grp">
              ${[['small', 'tile_small', 'Small'], ['medium', 'tile_medium', 'Medium'], ['large', 'tile_large', 'Large']].map(([size, icon, label]) => html`
                <button class="pq ${this.settings.thumbSize === size ? 'primary' : ''}" title="Tile ${label}" @click=${() => this[setThumbSize](size)}>
                  <k-icon name=${icon}></k-icon>
                </button>`)}
            </div>
          `}
        </div>
        ${!g ? html`<div class="center-empty ta-center tc-muted">Select a duplicate set to inspect it.</div>` : html`
          <div class="row ai-c jc-b mb">
            <h3 class="m0">${g.members.length} images <span class="tc-muted">|</span> <id-scores .scores=${g.signals}></id-scores></h3>
          </div>
          <div class="grid-fill" style="--col-min: ${TILE_SIZES[this.settings.thumbSize] || TILE_SIZES.medium}px">
            ${this[orderedMembers]().map(mi => {
              const it = this.items[mi];
              const previewRole = !this.keeperPath ? null : (it.path === this.keeperPath ? 'keep' : 'delete');
              return html`<id-image-card .item=${it} .checked=${this.selected.has(it.path)} .previewRole=${previewRole}
                @card-view=${this.onCardView} @card-toggle=${this.onCardToggle}></id-image-card>`;
            })}
          </div>
        `}
      </div>`;
  }

  // .pane is flexed (overriding shared's block default, scoped to this shadow root only)
  // so .center-empty can fill exactly the space left under the always-present Undo/Redo
  // row instead of a flat height:100% overflowing the pane by that row's own height.
  static styles = [shared, css`
    .pane {
      display: flex;
      flex-direction: column;
    }
    .center-empty {
      flex: 1;
      display: grid;
      place-items: center;
    }
  `];
}

customElements.define('id-detail', Detail);
