import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import { thumbnail } from '/lib/engine.js';
import './Scores.js';

/*
  Symbols
*/
const thumbPath = Symbol('thumbPath');
const loadThumb = Symbol('loadThumb');

export default class Dupe extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    group: { type: Object },
    items: { type: Array },
    selected: { type: Boolean, reflect: true },
    thumbSrc: { state: true }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Members
    */
    this[thumbPath] = null; // path the current thumbnail was loaded for

    /*
      Private Methods
    */
    // Reload the thumbnail whenever the first member's path changes (Lit reuses this
    // element's DOM after a re-cluster).
    this[loadThumb] = async () => {
      const path = this.group ? this.items[this.group.members[0]]?.path : null;
      if (!path || path === this[thumbPath]) return;
      this[thumbPath] = path;
      this.thumbSrc = '';
      const t = await thumbnail(path, 128);
      if (this[thumbPath] !== path) return;
      if (t?.dataUrl) this.thumbSrc = t.dataUrl;
    };

    /*
      Init Props
    */
    this.group = null;
    this.items = [];
    this.selected = false;
    this.thumbSrc = '';
  }

  /*
    Lifecycle Callbacks
  */
  connectedCallback() {
    super.connectedCallback();
    this.addEventListener('click', this.onClick);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('click', this.onClick);
  }
  updated() {
    this[loadThumb]();
  }

  /*
    Event Handlers
  */
  onClick = () => {
    if (this.group) this.dispatchEvent(new CustomEvent('dupe-select', { detail: { id: this.group.id } }));
  };

  /*
    Rendering
  */
  render() {
    const g = this.group;
    if (!g) return html``;
    const first = this.items[g.members[0]];
    const hasRef = g.members.some(mi => this.items[mi]?.ref);
    return html`
      <img class="thumb mrh" src=${this.thumbSrc}>
      <div class="col">
        <div><strong>${g.members.length} images</strong>${hasRef ? html`<span class="ref-badge mlh" title="Includes a reference image">REF</span>` : ''}</div>
        <div class="tc-muted ellipsis small">${first.name}</div>
        <id-scores class="small mtq" .scores=${g.signals}></id-scores>
      </div>`;
  }

  // Only the irreducibles: the clickable row's hover/selected states, the fixed-size
  // cover thumbnail, and the inline REF badge.
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      cursor: pointer;
      padding: 0 var(--spacer_h);
      border: 1px solid var(--c_border);
      border-radius: var(--radius);
    }
    :host(:hover) {
      border-color: var(--c_primary);
    }
    :host([selected]) {
      border-color: var(--c_primary);
      box-shadow: 0 0 0 1px var(--c_primary) inset;
    }
    .thumb {
      width: 52px;
      height: 52px;
      flex: none;
      object-fit: cover;
      border-radius: calc(var(--radius) / 1.5);
      background: var(--c_border);
    }
    .ref-badge {
      padding: 0 var(--spacer_q);
      font-size: var(--fs_small);
      font-weight: var(--fw_bold);
      letter-spacing: .03em;
      border-radius: var(--radius);
      background: var(--c_primary);
      color: var(--tc_on_primary, #fff);
      vertical-align: middle;
    }
    .ellipsis {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
  `;
}

customElements.define('id-dupe', Dupe);
