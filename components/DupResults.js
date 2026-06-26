import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import { shared } from '/lib/styles.js';
import { thumbnail } from '/lib/engine.js';
import { getUI } from '/lib/contexts.js';

/*
  Utility Functions
*/
// Per-tier icon, shared by the signal widget.
const TIER_ICON = { phash: 'tag', nn: 'network_intelligence', geo: 'shapes' };

/*
  Symbols
*/
const ui = Symbol('ui');
const select = Symbol('select');
const signals = Symbol('signals');

export default class DupResults extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    groups: { type: Array },
    items: { type: Array },
    summary: { type: Object },
    scanning: { type: Boolean }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Members
    */
    this[ui] = null; // dup-ui context, resolved on connect

    /*
      Private Methods
    */
    // Selecting a dupe set is shared UI state, so write it to the dup-ui context
    // rather than dispatching an event up to the app.
    this[select] = id => this[ui]?.set('selectedId', id);

    // Per-tier scores: icon + %, separated by | . Green (tc-success) if that tier
    // contributed to the grouping, muted otherwise.
    this[signals] = g => html`<strong class="sigs small d-if ai-c mtq">${g.signals.map((sig, k) => html`
      ${k ? html`<span class="tc-muted mxq">|</span>` : ''}
      <span class="d-if ai-c ${sig.contributed ? 'tc-success' : 'tc-muted'}">
        <k-icon name=${TIER_ICON[sig.tier]} class="mrq"></k-icon>${Math.round(sig.score * 100)}%
      </span>`)}</strong>`;

    /*
      Init Props
    */
    this.groups = [];
    this.items = [];
    this.summary = null;
    this.scanning = false;
  }

  /*
    Lifecycle Callbacks
  */
  connectedCallback() {
    super.connectedCallback();
    this[ui] = getUI(this);
    this[ui]?.addEventListener('context:set', this.onSelectionChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this[ui]?.removeEventListener('context:set', this.onSelectionChange);
  }

  // Reload a row's thumbnail whenever its path changes (Lit reuses row DOM after re-cluster).
  updated() {
    this.renderRoot.querySelectorAll('img.thumb').forEach(async img => {
      const path = img.dataset.path;
      if (img._loadedPath === path) return;
      img._loadedPath = path;
      img.removeAttribute('src');
      const t = await thumbnail(path, 128);
      if (img._loadedPath !== path) return;
      if (t?.dataUrl) img.src = t.dataUrl;
    });
  }

  /*
    Protected Members
  */
  get selectedId() { return this[ui]?.get('selectedId') ?? null; }

  /*
    Event Handlers
  */
  onSelectionChange = e => { if (e.detail.key === 'selectedId') this.requestUpdate(); };

  /*
    Rendering
  */
  render() {
    const s = this.summary;
    return html`
      <div class="pane">
        <div class="row ai-c jc-b mb">
          <h3 class="m0">Duplicates</h3>
          <span class="tc-muted">${this.groups.length ? `${this.groups.length} duplicate set${this.groups.length > 1 ? 's' : ''}` : ''}</span>
        </div>

        ${s ? html`<div class="tc-muted small mb">
          ${s.files} files · ${s.unique} unique · features: ${s.newFeat} new / ${s.reusedFeat} cached · geometry: ${s.newOrb} new / ${s.reusedOrb} cached
        </div>` : ''}

        ${!this.groups.length
          ? html`<div class="tc-muted">${this.scanning ? 'Scanning…' : this.items.length ? 'No duplicates at this confidence. Lower the slider to loosen.' : 'Run a scan to see results.'}</div>`
          : this.groups.map(g => html`
            <div class="group row ai-c ph mbh b r" data-selected=${this.selectedId === g.id ? '1' : '0'} @click=${() => this[select](g.id)}>
              <img class="thumb mrh" data-path=${this.items[g.members[0]].path}>
              <div class="col">
                <div><strong>${g.members.length} images</strong>${g.members.some(mi => this.items[mi]?.ref) ? html`<span class="ref-badge mlh" title="Includes a reference image">REF</span>` : ''}</div>
                <div class="tc-muted ellipsis small">${this.items[g.members[0]].name}</div>
                ${this[signals](g)}
              </div>
            </div>`)}
      </div>`;
  }

  // Only the irreducibles: the clickable row's hover/selected states, the fixed-size
  // cover thumbnail, tabular-nums for the score widgets, and the inline REF badge.
  static styles = [shared, css`
    .group { cursor: pointer; }
    .group:hover { border-color: var(--c_primary); }
    .group[data-selected="1"] { border-color: var(--c_primary); box-shadow: 0 0 0 1px var(--c_primary) inset; }
    .thumb { width: 52px; height: 52px; flex: none; object-fit: cover; border-radius: calc(var(--radius) / 1.5); background: var(--c_border); }
    .sigs { font-variant-numeric: tabular-nums; }
    .ref-badge { padding: 0 var(--spacer_q); font-size: var(--fs_small); font-weight: var(--fw_bold); letter-spacing: .03em; border-radius: var(--radius); background: var(--c_primary); color: var(--tc_on_primary, #fff); vertical-align: middle; }
  `];
}

customElements.define('dup-results', DupResults);
