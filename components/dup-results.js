import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import { shared } from '/lib/styles.js';
import { thumbnail } from '/lib/engine.js';

class DupResults extends ShadowComponent {
  static properties = {
    groups: { type: Array },
    items: { type: Array },
    selectedId: { type: Number },
    summary: { type: Object },
    scanning: { type: Boolean }
  };

  constructor() {
    super();
    this.groups = [];
    this.items = [];
    this.selectedId = null;
    this.summary = null;
    this.scanning = false;
  }

  #select(id) { this.dispatchEvent(new CustomEvent('select-group', { detail: { id }, bubbles: true, composed: true })); }

  // Per-tier scores: icon + %, separated by | . Green (tc-success) if that tier
  // contributed to the grouping, muted otherwise.
  #signals(g) {
    const ICON = { phash: 'tag', nn: 'network_intelligence', geo: 'shapes' };
    return html`<div class="sigs">${g.signals.map((sig, k) => html`
      ${k ? html`<span class="muted sep">|</span>` : ''}
      <span class="sig ${sig.contributed ? 'tc-success' : 'muted'}">
        <k-icon name=${ICON[sig.tier]}></k-icon>${Math.round(sig.score * 100)}%
      </span>`)}</div>`;
  }

  // Reload a row's thumbnail whenever its path changes (Lit reuses row DOM after re-cluster).
  updated() {
    this.renderRoot.querySelectorAll('img.thumb').forEach(async (img) => {
      const path = img.dataset.path;
      if (img._loadedPath === path) return;
      img._loadedPath = path;
      img.removeAttribute('src');
      const t = await thumbnail(path, 128);
      if (img._loadedPath !== path) return;
      if (t?.dataUrl) img.src = t.dataUrl;
    });
  }

  render() {
    const s = this.summary;
    return html`
      <div class="pane">
        <div class="row-between" style="margin-bottom:var(--spacer);">
          <h3 style="margin:0;">Results</h3>
          <span class="muted">${this.groups.length ? `${this.groups.length} duplicate set${this.groups.length > 1 ? 's' : ''}` : ''}</span>
        </div>

        ${s ? html`<div class="muted small" style="margin-bottom:var(--spacer);">
          ${s.files} files · ${s.unique} unique · features: ${s.newFeat} new / ${s.reusedFeat} cached · geometry: ${s.newOrb} new / ${s.reusedOrb} cached
        </div>` : ''}

        ${!this.groups.length
          ? html`<div class="muted">${this.scanning ? 'Scanning…' : this.items.length ? 'No duplicates at this confidence. Lower the slider to loosen.' : 'Run a scan to see results.'}</div>`
          : this.groups.map((g) => html`
            <div class="group" data-selected=${this.selectedId === g.id ? '1' : '0'} @click=${() => this.#select(g.id)}>
              <img class="thumb" data-path=${this.items[g.members[0]].path}>
              <div class="grow">
                <div><strong>${g.members.length} images</strong></div>
                <div class="muted ellipsis small">${this.items[g.members[0]].name}</div>
                ${this.#signals(g)}
              </div>
            </div>`)}
      </div>`;
  }

  static styles = [shared, css`
    .group { display: flex; gap: .6rem; align-items: center; padding: .5rem; margin-bottom: .5rem; border: 1px solid var(--c_border); border-radius: var(--radius); cursor: pointer; }
    .group:hover { border-color: var(--c_primary); }
    .group[data-selected="1"] { border-color: var(--c_primary); box-shadow: 0 0 0 1px var(--c_primary) inset; }
    .thumb { width: 52px; height: 52px; object-fit: cover; border-radius: calc(var(--radius) / 1.5); background: var(--c_border); flex: none; }
    .sigs { display: flex; align-items: center; gap: .35rem; margin-top: .2rem; font-size: .8em; font-weight: 600; font-variant-numeric: tabular-nums; }
    .sig { display: inline-flex; align-items: center; gap: .15rem; }
    .sig k-icon { opacity: .9; }
    .sep { font-weight: 400; }
  `];
}

customElements.define('dup-results', DupResults);
