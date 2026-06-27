import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import { thumbnail, fmtBytes } from '/lib/engine.js';

/*
  Symbols
*/
const imgPath = Symbol('imgPath');
const loadThumb = Symbol('loadThumb');
const emit = Symbol('emit');

export default class ImageCard extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    item: { type: Object },
    checked: { type: Boolean },
    thumbSrc: { state: true },
    dims: { state: true }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Members
    */
    this[imgPath] = null; // path the current thumbnail was loaded for

    /*
      Private Methods
    */
    // Reload the tile thumbnail (and dimensions) whenever the item's path changes
    // (Lit reuses card DOM across selections).
    this[loadThumb] = async () => {
      const path = this.item?.path || null;
      if (!path || path === this[imgPath]) return;
      this[imgPath] = path;
      this.thumbSrc = '';
      this.dims = '—';
      const t = await thumbnail(path, 480);
      if (this[imgPath] !== path) return; // selection changed again mid-load
      if (t?.dataUrl) this.thumbSrc = t.dataUrl;
      if (t?.width) this.dims = `${t.width} × ${t.height}`;
    };

    this[emit] = (name, detail) => this.dispatchEvent(new CustomEvent(name, { detail }));

    /*
      Init Props
    */
    this.item = null;
    this.checked = false;
    this.thumbSrc = '';
    this.dims = '—';
  }

  /*
    Lifecycle Callbacks
  */
  updated() {
    this[loadThumb]();
  }

  /*
    Event Handlers
  */
  onView = () => this[emit]('card-view', { path: this.item.path });
  onToggle = e => this[emit]('card-toggle', { path: this.item.path, checked: e.target.checked });
  // file-action is an app-level event (App listens on <id-detail>), so it has to cross
  // the shadow boundary and bubble up past Detail.
  onAction = action => this.dispatchEvent(new CustomEvent('file-action', { detail: { action, path: this.item.path }, bubbles: true, composed: true }));

  /*
    Rendering
  */
  render() {
    const it = this.item;
    if (!it) return html``;
    return html`
      ${it.ref ? html`<span class="ref-badge" title="Reference image">REF</span>` : ''}
      <img class="pic" src=${this.thumbSrc} @click=${this.onView}>
      <div class="ph">
        <div class="row"><strong class="ellipsis" title=${it.name}>${it.name}</strong></div>
        <div class="tc-muted small">${this.dims}</div>
        <div class="tc-muted small">${fmtBytes(it.size)}</div>
        <div class="tc-muted small ellipsis" title=${it.path}>${it.path}</div>
      </div>
      <div class="row ai-c ph bt actions">
        <input type="checkbox" class="sel mrh" .checked=${this.checked} @change=${this.onToggle}>
        <button class="col mrh" @click=${() => this.onAction('open')}><k-icon name="photo"></k-icon></button>
        <button class="col mrh" @click=${() => this.onAction('reveal')}><k-icon name="folder_open"></k-icon></button>
        <button class="col danger" @click=${() => this.onAction('trash')}><k-icon name="delete"></k-icon></button>
      </div>`;
  }

  // Only what kempo-css can't express: the tile's relative positioning + fixed
  // aspect-ratio image and the absolutely-positioned REF badge.
  static styles = css`
    :host {
      display: block;
      position: relative;
      border: 1px solid var(--c_border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .ref-badge {
      position: absolute;
      top: var(--spacer_q);
      left: var(--spacer_q);
      z-index: 1;
      padding: 0 var(--spacer_q);
      font-size: var(--fs_small);
      font-weight: var(--fw_bold);
      letter-spacing: .03em;
      border-radius: var(--radius);
      background: var(--c_primary);
      color: var(--tc_on_primary, #fff);
    }
    .pic {
      display: block;
      aspect-ratio: 4 / 3;
      object-fit: contain;
      background: #0003;
      width: 100%;
      cursor: pointer;
    }
    .ai-c {
      align-items: center;
    }
    .ellipsis {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    /* kempo-css's .row wraps and .col has no min-width:0, so at just the wrong
       container width this row's last button (delete) would wrap onto its own
       line before any button actually ran out of room to shrink into. */
    .actions {
      flex-wrap: nowrap;
    }
    .actions .col {
      min-width: 0;
    }
  `;
}

customElements.define('id-image-card', ImageCard);
