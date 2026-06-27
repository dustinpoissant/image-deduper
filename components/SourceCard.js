import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import './SourceItem.js';

/*
  Symbols
*/
const emit = Symbol('emit');

export default class SourceCard extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    label: { type: String },
    hint: { type: String },
    sources: { type: Array }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Methods
    */
    this[emit] = (name, detail) => this.dispatchEvent(new CustomEvent(name, { detail }));

    /*
      Init Props
    */
    this.label = '';
    this.hint = '';
    this.sources = [];
  }

  /*
    Event Handlers
  */
  onAddImages = () => this[emit]('add-images');
  onAddFolder = () => this[emit]('add-folder');
  onRemove = e => this[emit]('remove', e.detail);

  /*
    Rendering
  */
  render() {
    return html`
      <div class="row ai-c ph bb">
        <strong class="card-title col">${this.label}</strong>
        <span class="btn-grp">
          <button class="addbtn b pq tc-default" title="Add image(s)" @click=${this.onAddImages}><k-icon name="photo_add"></k-icon></button>
          <button class="addbtn b pq tc-default" title="Add folder" @click=${this.onAddFolder}><k-icon name="folder_add"></k-icon></button>
        </span>
      </div>
      <div class="ph">
        <p class="tc-muted small m0">${this.hint}</p>
        ${this.sources.length ? this.sources.map((s, i) => html`
          <id-source-item class=" b r pxh pyq mt" path=${s.path} kind=${s.kind} .index=${i} @remove=${this.onRemove}></id-source-item>`)
          : html`<div class="tc-muted small mt">Nothing added yet</div>`}
      </div>`;
  }

  static styles = css`
    :host {
      display: block;
      border: 1px solid var(--c_border);
      border-radius: var(--radius);
    }
    .card-title {
      font-size: 1.15rem;
    }
    .ai-c {
      align-items: center;
    }
    .addbtn {
      background: transparent !important;
    }
  `;
}

customElements.define('id-source-card', SourceCard);
