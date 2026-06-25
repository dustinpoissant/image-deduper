import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import PhotoViewer from '/modules/kempo-ui/dist/components/PhotoViewer.js';
import { shared } from '/lib/styles.js';
import { thumbnail, fmtBytes } from '/lib/engine.js';
import CompareViewer from './compare-viewer.js';

// Preference order for "most lossless" when resolution ties — lower index wins.
const FORMAT_PRIORITY = ['png', 'tiff', 'tif', 'bmp', 'webp', 'jpg', 'jpeg', 'gif'];
const formatRank = (name) => {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const idx = FORMAT_PRIORITY.indexOf(ext);
  return idx === -1 ? FORMAT_PRIORITY.length : idx;
};

const TILE_SIZES = { small: 140, medium: 220, large: 320 };

class DupDetail extends ShadowComponent {
  static properties = {
    group: { type: Object },
    items: { type: Array },
    selected: { type: Object },
    settings: { type: Object }
  };

  constructor() {
    super();
    this.group = null;
    this.items = [];
    this.selected = new Set();
    this.settings = { thumbSize: 'medium' };
    this._selKey = '';
  }

  #act(action, path, onDone) { this.dispatchEvent(new CustomEvent('file-action', { detail: { action, path, onDone }, bubbles: true, composed: true })); }

  #setThumbSize(value) { this.dispatchEvent(new CustomEvent('setting-change', { detail: { key: 'thumbSize', value }, bubbles: true, composed: true })); }

  // Global "Enter" shortcut entry point — opens the first photo of whatever set is selected.
  openFirst() { this.#openViewer(0); }

  // Global "Delete" shortcut entry point (when the Photo Viewer is closed) — same as
  // clicking the Auto Delete button.
  triggerAutoDelete() { this.#autoDelete(); }

  // Global "~" shortcut entry point — same as clicking the Not Duplicates button.
  triggerNotDuplicates() { this.#notDuplicates(); }

  // Global "Backspace" shortcut entry point — same as clicking Delete Selected
  // (a no-op if nothing's checked, just like the button being disabled).
  triggerDeleteSelected() { this.#deleteSelected(); }

  // Open every image in the current set as a scrollable fullscreen gallery, starting on the clicked one.
  async #openViewer(startIndex) {
    const g = this.group;
    if (!g) return;
    // Close any gallery already open (e.g. the Up/Down shortcut switching dupe sets
    // while viewing one) so they don't stack — each .close() tears its own container down.
    document.querySelectorAll('k-photo-viewer[fullscreen]').forEach(v => v.close());
    const paths = g.members.map(mi => this.items[mi].path);
    const content = await Promise.all(g.members.map(async (mi) => {
      const it = this.items[mi];
      const t = await thumbnail(it.path, 1600);
      return {
        src: t?.dataUrl || '',
        alt: it.name,
        caption: `<strong>${it.name}</strong><div class="muted">${t?.width ? `${t.width} × ${t.height}` : '—'} &middot; ${fmtBytes(it.size)}</div>`
      };
    }));
    const opened = PhotoViewer.open(content, startIndex);
    this.#wireViewerDelete(opened, paths);
  }

  // While the fullscreen gallery is open, Delete removes whichever photo is
  // currently shown (respecting confirmDelete) and closes the viewer — the
  // underlying group is about to change anyway once the item is removed.
  #wireViewerDelete(opened, paths) {
    const viewers = Array.from(opened.parentElement.querySelectorAll('k-photo-viewer'));

    const onKeydown = (e) => {
      if (e.key !== 'Delete') return;
      const current = viewers.find(v => v.fullscreen);
      if (!current) return;
      const path = paths[viewers.indexOf(current)];
      if (!path) return;
      e.preventDefault();
      this.#act('trash', path, (deleted) => { if (deleted) current.close(); });
    };

    document.addEventListener('keydown', onKeydown);
    const cleanup = () => {
      if (!viewers.some(v => v.fullscreen)) {
        document.removeEventListener('keydown', onKeydown);
        viewers.forEach(v => v.removeEventListener('fullscreenclose', cleanup));
      }
    };
    viewers.forEach(v => v.addEventListener('fullscreenclose', cleanup));
  }

  // Keep the highest-resolution image (ties broken by most-lossless format, then
  // smallest file size, then alphabetically), and ask to delete the rest.
  async #autoDelete() {
    const g = this.group;
    if (!g || g.members.length < 2) return;

    const candidates = await Promise.all(g.members.map(async (mi) => {
      const it = this.items[mi];
      const t = await thumbnail(it.path, 480);
      return { path: it.path, name: it.name, size: it.size, area: (t?.width && t?.height) ? t.width * t.height : 0 };
    }));

    const ranked = [...candidates].sort((a, b) => {
      if (b.area !== a.area) return b.area - a.area;
      const fa = formatRank(a.name), fb = formatRank(b.name);
      if (fa !== fb) return fa - fb;
      if (a.size !== b.size) return a.size - b.size;
      return a.name.localeCompare(b.name);
    });

    const [keep, ...rest] = ranked;
    this.dispatchEvent(new CustomEvent('auto-delete', {
      detail: { keepPath: keep.path, keepName: keep.name, deletePaths: rest.map(d => d.path) },
      bubbles: true, composed: true
    }));
  }

  // Per-tier scores: icon + %, separated by | . Green (tc-success) if that tier
  // contributed to the grouping, muted otherwise. Mirrors dup-results.js.
  #signals(g) {
    const ICON = { phash: 'tag', nn: 'network_intelligence', geo: 'shapes' };
    return html`<span class="sigs">${g.signals.map((sig, k) => html`
      ${k ? html`<span class="muted sep">|</span>` : ''}
      <span class="sig ${sig.contributed ? 'tc-success' : 'muted'}">
        <k-icon name=${ICON[sig.tier]}></k-icon>${Math.round(sig.score * 100)}%
      </span>`)}</span>`;
  }

  #toggleSelect(path, checked) {
    const next = new Set(this.selected);
    if (checked) next.add(path); else next.delete(path);
    this.selected = next;
  }

  #deleteSelected() {
    if (!this.selected.size) return;
    const paths = [...this.selected];
    this.selected = new Set();
    this.dispatchEvent(new CustomEvent('delete-selected', { detail: { paths }, bubbles: true, composed: true }));
  }

  // With nothing checked, flag every image in the whole set as not-duplicates of
  // each other; with 2+ checked, scope it to just those.
  #notDuplicates() {
    const g = this.group;
    const paths = this.selected.size >= 2 ? [...this.selected]
      : g ? g.members.map(mi => this.items[mi].path)
      : null;
    if (!paths || paths.length < 2) return;
    this.selected = new Set();
    this.dispatchEvent(new CustomEvent('not-duplicates', { detail: { paths }, bubbles: true, composed: true }));
  }

  // Two images are unambiguous to compare even with nothing checked.
  #compareEnabled() { return this.selected.size === 2 || (this.group && this.group.members.length === 2); }

  // Side-by-side wipe compare of the two selected images (or the set's only two
  // images, when there's nothing else it could mean), for spotting small
  // differences (e.g. a wink) between near-identical shots.
  async #compareSelected() {
    const paths = this.selected.size === 2 ? [...this.selected]
      : this.group && this.group.members.length === 2 ? this.group.members.map(mi => this.items[mi].path)
      : null;
    if (!paths) return;
    const [pathA, pathB] = paths;
    const itemFor = (p) => this.items.find(i => i.path === p);
    const [a, b] = await Promise.all([pathA, pathB].map(async (p) => {
      const it = itemFor(p);
      const t = await thumbnail(it.path, 1600);
      return { name: it.name, src: t?.dataUrl || '', w: t?.width || 0, h: t?.height || 0 };
    }));
    CompareViewer.open({
      leftSrc: a.src, leftLabel: a.name,
      rightSrc: b.src, rightLabel: b.name,
      frameW: Math.max(a.w, b.w), frameH: Math.max(a.h, b.h)
    });
  }

  // Lit reuses card DOM across selections, so reload whenever a card's path changes
  // (clearing the stale image immediately to avoid showing the previous set's pic).
  updated(changedProperties) {
    if (changedProperties.has('group')) {
      // Clear the checkbox selection whenever the actual set of members changes
      // (not on every recluster — same members just get reordered/rescored).
      const key = this.group ? this.group.members.map(mi => this.items[mi]?.path).join('|') : '';
      if (key !== this._selKey) this.selected = new Set();
      this._selKey = key;
    }

    this.renderRoot.querySelectorAll('.imgcard').forEach(async (card) => {
      const path = card.dataset.path;
      if (card._loadedPath === path) return;
      card._loadedPath = path;
      const img = card.querySelector('.pic');
      img.removeAttribute('src');
      card.querySelector('.dims').textContent = '—';
      const t = await thumbnail(path, 480);
      if (card._loadedPath !== path) return; // selection changed again mid-load
      if (t?.dataUrl) img.src = t.dataUrl;
      if (t?.width) card.querySelector('.dims').textContent = `${t.width} × ${t.height}`;
    });
  }

  render() {
    const g = this.group;
    if (!g) return html`<div class="pane"><div class="center-empty muted">Select a duplicate set to inspect it.</div></div>`;
    return html`
      <div class="pane">
        <div class="row-between" style="margin-bottom:var(--spacer);">
          <h3 style="margin:0;">${g.members.length} images <span class="muted">|</span> ${this.#signals(g)}</h3>
        </div>
        <div class="ctrl-bar bb pb">
          <button class="danger" @click=${() => this.#autoDelete()}><k-icon name="delete_auto"></k-icon> Auto Delete</button>
          <button class="danger" ?disabled=${this.selected.size === 0} @click=${() => this.#deleteSelected()}>
            <k-icon name="delete_sweep"></k-icon> Delete Selected
          </button>
          <button ?disabled=${!this.#compareEnabled()} @click=${() => this.#compareSelected()}>
            <k-icon name="compare_arrows"></k-icon> Compare
          </button>
          <button @click=${() => this.#notDuplicates()}>
            <b>≠</b> Not Duplicates
          </button>
          <span class="grow"></span>
          <div class="btn-grp tile-size">
            ${[['small', 'tile_small', 'Small'], ['medium', 'tile_medium', 'Medium'], ['large', 'tile_large', 'Large']].map(([size, icon, label]) => html`
              <button class=${this.settings.thumbSize === size ? 'primary' : ''} title="Tile ${label}" @click=${() => this.#setThumbSize(size)}>
                <k-icon name=${icon}></k-icon>
              </button>`)}
          </div>
        </div>
        <div class="grid" style="--tile-min: ${TILE_SIZES[this.settings.thumbSize] || TILE_SIZES.medium}px">
          ${g.members.map((mi, idx) => {
            const it = this.items[mi];
            return html`
              <div class="imgcard" data-path=${it.path}>
                <img class="pic" @click=${() => this.#openViewer(idx)}>
                <div class="meta">
                  <div class="row-between"><strong class="ellipsis" title=${it.name}>${it.name}</strong></div>
                  <div class="muted dims">—</div>
                  <div class="muted">${fmtBytes(it.size)}</div>
                  <div class="muted ellipsis" title=${it.path}>${it.path}</div>
                </div>
                <div class="acts">
                  <input type="checkbox" class="sel" .checked=${this.selected.has(it.path)}
                    @change=${(e) => this.#toggleSelect(it.path, e.target.checked)}>
                  <button @click=${() => this.#act('open', it.path)}><k-icon name="photo"></k-icon></button>
                  <button @click=${() => this.#act('reveal', it.path)}><k-icon name="folder_open"></k-icon></button>
                  <button class="danger" @click=${() => this.#act('trash', it.path)}><k-icon name="delete"></k-icon></button>
                </div>
              </div>`;
          })}
        </div>
      </div>`;
  }

  static styles = [shared, css`
    .sigs { display: inline-flex; align-items: center; gap: .35rem; font-variant-numeric: tabular-nums; vertical-align: middle; }
    .sig { display: inline-flex; align-items: center; gap: .2rem; }
    .sig k-icon { opacity: .9; }
    .sep { font-weight: 400; }
    .ctrl-bar { display: flex; align-items: center; gap: .5rem; margin-bottom: var(--spacer); }
    .tile-size { flex: 0 0 auto; }
    .tile-size button { padding: .4rem .55rem; }
    .grid { display: grid; gap: var(--spacer); grid-template-columns: repeat(auto-fill, minmax(var(--tile-min, 220px), 1fr)); }
    .imgcard { border: 1px solid var(--c_border); border-radius: var(--radius); overflow: hidden; display: flex; flex-direction: column; }
    .imgcard .pic { aspect-ratio: 4 / 3; object-fit: contain; background: #0003; width: 100%; cursor: pointer; }
    .imgcard .meta { padding: .5rem; font-size: .82em; }
    .imgcard .acts { display: flex; align-items: center; gap: .25rem; padding: .5rem; border-top: 1px solid var(--c_border); }
    .imgcard .acts button { flex: 1; }
    .imgcard .acts .sel { flex: 0 0 auto; }
    .center-empty { height: 100%; display: grid; place-items: center; text-align: center; }
  `];
}

customElements.define('dup-detail', DupDetail);
