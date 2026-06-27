import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html } from '/modules/kempo-ui/dist/lit-all.min.js';
import { shared } from '/lib/styles.js';
import { getUI } from '/lib/contexts.js';
import './Dupe.js';

/*
  Symbols
*/
const ui = Symbol('ui');
const select = Symbol('select');

export default class Results extends ShadowComponent {
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

  /*
    Protected Members
  */
  get selectedId() { return this[ui]?.get('selectedId') ?? null; }

  /*
    Event Handlers
  */
  onSelectionChange = e => { if (e.detail.key === 'selectedId') this.requestUpdate(); };
  onDupeSelect = e => this[select](e.detail.id);

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
            <id-dupe class="mbh pyq pxh" .group=${g} .items=${this.items}
              .selected=${this.selectedId === g.id} @dupe-select=${this.onDupeSelect}></id-dupe>`)}
      </div>`;
  }

  static styles = [shared];
}

customElements.define('id-results', Results);
