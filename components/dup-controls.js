import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import '/modules/kempo-ui/dist/components/Slider.js';
import '/modules/kempo-ui/dist/components/Toggle.js';
import '/modules/kempo-ui/dist/components/Progress.js';
import '/modules/kempo-ui/dist/components/Accordion.js';
import { shared } from '/lib/styles.js';

class DupControls extends ShadowComponent {
  static properties = {
    dirs: { type: Array },
    settings: { type: Object },
    thresholds: { type: Object },
    scanning: { type: Boolean },
    progress: { type: Object }
  };

  constructor() {
    super();
    this.dirs = [];
    this.settings = { recursive: true, usePhash: true, useNN: true, useGeo: true, preferGPU: true, confirmDelete: true };
    this.thresholds = { phash: 70, nn: 90, geo: 55 };
    this.scanning = false;
    this.progress = null;
    this._editingTier = null;
  }

  #emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true })); }

  #editThreshold(tier) { this._editingTier = tier; this.requestUpdate(); }

  // Clamp/round to the slider's range, emit the same event the slider uses, then
  // re-append the % (the input shows a bare number only while focused).
  #commitThreshold(tier, raw) {
    this._editingTier = null;
    const n = parseFloat(raw);
    const value = Number.isFinite(n) ? Math.min(99, Math.max(1, Math.round(n))) : Math.round(this.thresholds[tier]);
    this.#emit('threshold-change', { tier, value });
    this.requestUpdate();
  }

  #commitMaxGroup(raw) {
    const n = parseFloat(raw);
    const value = Number.isFinite(n) ? Math.min(30, Math.max(2, Math.round(n))) : Math.round(this.settings.maxGroupSize);
    this.#emit('setting-change', { key: 'maxGroupSize', value });
    this.requestUpdate();
  }

  // A labelled on/off toggle bound to a settings key.
  #toggleRow(key, label) {
    return html`
      <div class="check">
        <k-toggle .value=${this.settings[key]} @change=${(e) => this.#emit('setting-change', { key, value: e.detail.value })}></k-toggle>
        <span>${label}</span>
      </div>`;
  }

  // A detection tier as an accordion section: icon + name in the header; description,
  // enable toggle and threshold slider revealed inside the panel.
  #tier(key, tier, icon, label, desc) {
    const off = !this.settings[key];
    const editing = this._editingTier === tier;
    const display = editing ? String(Math.round(this.thresholds[tier])) : `${Math.round(this.thresholds[tier])}%`;
    return html`
      <k-accordion-header for-panel=${tier} class=${off ? 'tier-off' : ''}>
        <k-icon name=${icon}></k-icon><span class="acc-title ${off ? 'disabled' : ''}">${label}</span>
      </k-accordion-header>
      <k-accordion-panel name=${tier}>
        <div class="panel-body stack pt">
          <p class="muted small">${desc}</p>
          ${this.#toggleRow(key, 'Enable ' + label)}
          <div class="thresh">
            <k-slider min="1" max="99" tooltip format="0%" .value=${String(this.thresholds[tier])}
              @change=${(e) => this.#emit('threshold-change', { tier, value: Number(e.target.value) })}></k-slider>
            <input type="text" inputmode="numeric" class="thresh-val" .value=${display}
              @focus=${(e) => { this.#editThreshold(tier); e.target.select(); }}
              @blur=${(e) => this.#commitThreshold(tier, e.target.value)}
              @keydown=${(e) => { if (e.key === 'Enter') e.target.blur(); }}>
          </div>
        </div>
      </k-accordion-panel>`;
  }

  render() {
    return html`
      <div class="pane left stack">

        <button class="primary wfull" @click=${() => this.#emit('add-folder')}>+ Add Folder</button>

        <div class="stack">
          ${this.dirs.map((d, i) => html`
            <div class="dir-item">
              <span class="grow ellipsis" title=${d}>${d}</span>
              <span class="x" @click=${() => this.#emit('remove-dir', { index: i })}>&times;</span>
            </div>`)}
        </div>

        <div class="field">
          <h5>Detection Algorithms</h5>
          <k-accordion multiple persistent-id="dup-tiers">
            ${this.#tier('usePhash', 'phash', 'tag', 'Perceptual hash',
              'Catches near-identical pixels — the same image re-saved, rescaled or recompressed, plus 90° rotations and mirror flips. Fast and exact, but it can\'t find crops or arbitrary rotations.')}
            ${this.#tier('useNN', 'nn', 'network_intelligence', 'Neural look-alikes',
              'A neural network (DINOv2) measures visual similarity, so it can spot edited or filtered versions. It also rates different photos of the same subject as similar — keep the threshold high so it only groups near-identical images.')}
            ${this.#tier('useGeo', 'geo', 'shapes', 'Geometric (ORB)',
              'Matches actual image content (keypoints + geometry), catching crops, rotations, scaling and watermarked copies of the same photo. The most reliable signal for true duplicates.')}
          </k-accordion>
        </div>

        <k-accordion persistent-id="dup-settings" class="settings-accordion">
          <k-accordion-header for-panel="settings">
            <k-icon name="settings"></k-icon><span class="acc-title">Settings</span>
          </k-accordion-header>
          <k-accordion-panel name="settings">
            <div class="panel-body stack pt">
              ${this.#toggleRow('recursive', 'Include subfolders')}
              ${this.#toggleRow('preferGPU', 'Use GPU if available')}
              ${this.#toggleRow('confirmDelete', 'Confirm deletion')}
              <div class="field">
                <span>Max images per dupe set</span>
                <div class="thresh">
                  <k-slider min="2" max="30" tooltip .value=${String(this.settings.maxGroupSize)}
                    @change=${(e) => this.#emit('setting-change', { key: 'maxGroupSize', value: Number(e.target.value) })}></k-slider>
                  <input type="text" inputmode="numeric" class="thresh-val"
                    .value=${String(Math.round(this.settings.maxGroupSize))}
                    @focus=${(e) => e.target.select()}
                    @blur=${(e) => this.#commitMaxGroup(e.target.value)}
                    @keydown=${(e) => { if (e.key === 'Enter') e.target.blur(); }}>
                </div>
              </div>
              <div style="display:flex; gap:.5rem;">
                <button class="btn danger small" @click=${() => this.#emit('clear-cache')}>Clear cache</button>
                <button class="btn danger small" @click=${() => this.#emit('reset-settings')}>Reset settings</button>
              </div>
            </div>
          </k-accordion-panel>
        </k-accordion>

        <button class="${this.scanning ? 'danger' : 'primary'} wfull" ?disabled=${!this.scanning && this.dirs.length === 0}
          @click=${() => this.#emit(this.scanning ? 'cancel-scan' : 'start-scan')}>${this.scanning ? 'Cancel Scan' : 'Start Scan'}</button>

        ${this.progress ? html`
          <div class="stack">
            <k-progress percentage=${String(Math.round(this.progress.p * 100))} label></k-progress>
            <div class="muted">${this.progress.text || ''}</div>
          </div>` : ''}
      </div>`;
  }

  static styles = [shared, css`
    .pane.left { background: var(--c_bg__alt, var(--c_bg)); }
    hr { border: none; border-top: 1px solid var(--c_border); width: 100%; }
    .dir-item { display: flex; align-items: center; gap: .5rem; padding: .35rem .5rem; border: 1px solid var(--c_border); border-radius: var(--radius); }
    .dir-item .x { cursor: pointer; opacity: .6; }
    .dir-item .x:hover { opacity: 1; }
    .field { display: flex; flex-direction: column; gap: .25rem; }
    .check { display: flex; align-items: center; gap: .6rem; }
    k-toggle {
      --switch_height: 1.35rem;
      --switch_width: 2.2rem;
      --handle_size__off: .75rem;
      --handle_size__on: 1.05rem;
      margin-bottom: 0;
    }
    .thresh { display: flex; align-items: center; gap: .5rem; }
    .thresh k-slider { flex: 1; display: block; }
    /* kempo-css's generic input selector outranks a single class on specificity,
       so the box-model overrides need !important to actually take effect. */
    .thresh-val {
      display: inline-block !important; width: 2.6rem !important; flex: 0 0 auto;
      font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; color: inherit;
      background: transparent !important; border: 1px solid transparent !important; padding: 0 .2rem !important;
      border-radius: var(--radius);
    }
    .thresh-val:not(:disabled):focus {
      background: var(--input_bg) !important; border-color: var(--c_input_border) !important;
    }
    k-progress { display: block; width: 100%; }

    /* Detection-tier accordion */
    k-accordion { display: block; border: 1px solid var(--c_border); border-radius: var(--radius); overflow: hidden; }
    k-accordion-header { padding: .55rem .7rem; display: flex; align-items: center; }
    k-accordion-header k-icon { margin: 0 .5rem 0 .25rem; }
    .acc-title { font-weight: 600; }
    .acc-title.disabled { text-decoration: line-through; }
    k-accordion-header.tier-off { opacity: .55; }
    .panel-body { padding: 0 .7rem .8rem; }
    .panel-body p { margin: 0 0 .25rem; }
  `];
}

customElements.define('dup-controls', DupControls);
