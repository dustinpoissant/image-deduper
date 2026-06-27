import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';

export default class SourceItem extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    path: { type: String },
    kind: { type: String },
    index: { type: Number }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Init Props
    */
    this.path = '';
    this.kind = 'file';
    this.index = -1;
  }

  /*
    Event Handlers
  */
  onRemove = () => this.dispatchEvent(new CustomEvent('remove', { detail: { index: this.index } }));

  /*
    Rendering
  */
  render() {
    return html`
      <k-icon class="tc-muted mrh" name=${this.kind === 'file' ? 'photo' : 'folder_open'}></k-icon>
      <span class="col ellipsis" title=${this.path}>${this.path.split(/[\\/]/).filter(Boolean).pop() || this.path}</span>
      <button class="no-btn tc-muted mlh" title="Remove" @click=${this.onRemove}>&times;</button>`;
  }

  static styles = css`
    :host {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
    }
    .ellipsis {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
  `;
}

customElements.define('id-source-item', SourceItem);
