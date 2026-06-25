import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';

// Fullscreen wipe-compare: the left photo is clipped to the area left of the
// cursor, revealing the right photo underneath — move the mouse to scrub
// between the two to spot small differences (e.g. a wink) between near-dupes.
class CompareViewer extends ShadowComponent {
  static properties = {
    leftSrc: { type: String },
    rightSrc: { type: String },
    leftLabel: { type: String },
    rightLabel: { type: String },
    frameW: { type: Number },
    frameH: { type: Number },
    split: { type: Number }
  };

  constructor() {
    super();
    this.leftSrc = '';
    this.rightSrc = '';
    this.leftLabel = '';
    this.rightLabel = '';
    this.frameW = 0;
    this.frameH = 0;
    this.split = 50;
  }

  #onMove = (e) => {
    const rect = this.renderRoot.querySelector('.frame').getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    this.split = rect.width ? (x / rect.width) * 100 : 50;
  };

  #close = () => { this.dispatchEvent(new CustomEvent('close')); };

  #onOverlayClick = (e) => { if (e.target === e.currentTarget) this.#close(); };

  #onKeydown = (e) => { if (e.key === 'Escape') this.#close(); };

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('keydown', this.#onKeydown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('keydown', this.#onKeydown);
  }

  render() {
    const frameStyle = this.frameW && this.frameH ? `aspect-ratio: ${this.frameW} / ${this.frameH};` : '';
    return html`
      <div class="overlay" @click=${this.#onOverlayClick} @mousemove=${this.#onMove}>
        <button class="close no-btn" @click=${this.#close}><k-icon name="close"></k-icon></button>
        <div class="frame" style=${frameStyle}>
          <img class="img base" src=${this.rightSrc} alt="">
          <img class="img clipped" src=${this.leftSrc} alt="" style="clip-path: inset(0 ${100 - this.split}% 0 0);">
          <div class="divider" style="left:${this.split}%"></div>
          <div class="label left">${this.leftLabel}</div>
          <div class="label right">${this.rightLabel}</div>
        </div>
      </div>`;
  }

  static styles = css`
    :host { display: block; }
    .overlay {
      position: fixed; inset: 0; z-index: 80;
      background: rgba(0,0,0,0.9);
      display: flex; align-items: center; justify-content: center;
      padding: 2rem; cursor: col-resize;
    }
    .frame { position: relative; max-width: 100%; max-height: 100%; line-height: 0; }
    .img { display: block; max-width: 100%; max-height: 85vh; object-fit: contain; user-select: none; pointer-events: none; width: 100%; height: 100%; }
    .clipped { position: absolute; inset: 0; }
    .divider { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; transform: translateX(-1px); pointer-events: none; }
    .label { position: absolute; top: .5rem; color: #fff; background: rgba(0,0,0,.6); padding: .25rem .5rem; border-radius: var(--radius); font-size: .85em; pointer-events: none; }
    .label.left { left: .5rem; }
    .label.right { right: .5rem; }
    .close { position: absolute; top: 1rem; right: 1rem; z-index: 1; background: none; border: none; color: #fff; cursor: pointer; }
  `;

  static open({ leftSrc, leftLabel, rightSrc, rightLabel, frameW, frameH }) {
    const mountRoot = document.querySelector('[data-overlay-root]') || document.body;

    const container = document.createElement('div');
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '0';
    container.style.height = '0';
    container.style.overflow = 'hidden';
    container.style.zIndex = '80';

    const viewer = document.createElement('compare-viewer');
    viewer.leftSrc = leftSrc;
    viewer.rightSrc = rightSrc;
    viewer.leftLabel = leftLabel || '';
    viewer.rightLabel = rightLabel || '';
    viewer.frameW = frameW || 0;
    viewer.frameH = frameH || 0;
    container.appendChild(viewer);
    mountRoot.appendChild(container);

    document.body.classList.add('no-scroll');
    if (mountRoot !== document.body) mountRoot.classList.add('no-scroll');

    const cleanup = () => {
      document.body.classList.remove('no-scroll');
      if (mountRoot !== document.body) mountRoot.classList.remove('no-scroll');
      container.remove();
    };
    viewer.addEventListener('close', cleanup);

    return viewer;
  }
}

customElements.define('compare-viewer', CompareViewer);
export default CompareViewer;
