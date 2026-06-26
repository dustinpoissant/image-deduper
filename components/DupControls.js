import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import '/modules/kempo-ui/dist/components/Slider.js';
import '/modules/kempo-ui/dist/components/Toggle.js';
import '/modules/kempo-ui/dist/components/Progress.js';
import '/modules/kempo-ui/dist/components/Accordion.js';
import { shared } from '/lib/styles.js';
import { getConfig } from '/lib/contexts.js';
import api from '/lib/api.js';

/*
  Symbols
*/
const cfg = Symbol('cfg');
const emit = Symbol('emit');
const setSetting = Symbol('setSetting');
const setThreshold = Symbol('setThreshold');
const editThreshold = Symbol('editThreshold');
const commitThreshold = Symbol('commitThreshold');
const commitMaxGroup = Symbol('commitMaxGroup');
const addImages = Symbol('addImages');
const addFolder = Symbol('addFolder');
const addSources = Symbol('addSources');
const removeSource = Symbol('removeSource');
const toggleRow = Symbol('toggleRow');
const sliderRow = Symbol('sliderRow');
const tier = Symbol('tier');
const sourceCard = Symbol('sourceCard');

export default class DupControls extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    // Transient scan state, owned by the app and passed down.
    scanning: { type: Boolean },
    progress: { type: Object },
    // Which tier's value box is being typed in: the input shows a bare number while
    // focused, the % suffix otherwise — so render reacts to this.
    editingTier: { state: true }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Members
    */
    this[cfg] = null; // dup-config context, resolved on connect

    /*
      Private Methods
    */
    this[emit] = (name, detail) => this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));

    // Config writes go straight to the dup-config context (which persists itself and
    // notifies every listener, including the app for re-clustering).
    this[setSetting] = (key, value) => this[cfg]?.set('settings', { ...this.settings, [key]: value });
    this[setThreshold] = (t, value) => this[cfg]?.set('thresholds', { ...this.thresholds, [t]: value });

    this[editThreshold] = t => { this.editingTier = t; };

    // Clamp/round to the slider's range, write it, then drop back to the %-suffixed
    // display (editingTier → null re-renders the input).
    this[commitThreshold] = (t, raw) => {
      this.editingTier = null;
      const n = parseFloat(raw);
      this[setThreshold](t, Number.isFinite(n) ? Math.min(99, Math.max(1, Math.round(n))) : Math.round(this.thresholds[t]));
    };

    this[commitMaxGroup] = raw => {
      const n = parseFloat(raw);
      this[setSetting]('maxGroupSize', Number.isFinite(n) ? Math.min(30, Math.max(2, Math.round(n))) : Math.round(this.settings.maxGroupSize));
    };

    // Native pickers run in the main process via the shared api, then the chosen paths
    // are merged into the sources config. Adding never clears results (the app only
    // does that on removal — see DupApp.onConfigChange).
    this[addImages] = async set => {
      const picked = await api.selectImages();
      if (picked.length) this[addSources](set, 'file', picked);
    };
    this[addFolder] = async set => {
      const picked = await api.selectDirectories();
      if (picked.length) this[addSources](set, 'folder', picked);
    };
    // Add the same source to one set, or to both (the "add to both" convenience that keeps
    // the simple all-pairs workflow). Skips duplicates already present in that set.
    this[addSources] = (set, kind, paths) => {
      const sources = this.sources;
      const next = { reference: [...sources.reference], search: [...sources.search] };
      for (const s of (set === 'both' ? ['reference', 'search'] : [set])) {
        for (const p of paths) if (!next[s].some(x => x.path === p)) next[s].push({ path: p, kind });
      }
      this[cfg]?.set('sources', next);
    };
    this[removeSource] = (set, index) => {
      const sources = this.sources;
      const next = { reference: [...sources.reference], search: [...sources.search] };
      next[set].splice(index, 1);
      this[cfg]?.set('sources', next);
    };

    // A labelled on/off toggle bound to a settings key. `mt` adds top margin to space it
    // from the previous sibling — every call site passes it except the first in a group.
    this[toggleRow] = (key, label, mt = true) => html`
      <div class="row ai-c ${mt ? 'mt' : ''}">
        <k-toggle .value=${this.settings[key]} @change=${e => this[setSetting](key, e.detail.value)}></k-toggle>
        <span class="mlh">${label}</span>
      </div>`;

    // The slider + editable value box shared by every threshold and the max-group setting.
    this[sliderRow] = (slider, input, mt = false) => html`<div class="row ai-c nowrap ${mt ? 'mt' : ''}">${slider}${input}</div>`;

    // A detection tier as an accordion section: icon + name in the header; description,
    // enable toggle and threshold slider revealed inside the panel.
    this[tier] = (key, t, icon, label, desc) => {
      const off = !this.settings[key];
      const display = this.editingTier === t ? String(Math.round(this.thresholds[t])) : `${Math.round(this.thresholds[t])}%`;
      return html`
        <k-accordion-header for-panel=${t} class="row ai-c ph ${off ? 'tier-off' : ''}">
          <k-icon name=${icon} class="mrh mlq"></k-icon><strong class=${off ? 'td-lt' : ''}>${label}</strong>
        </k-accordion-header>
        <k-accordion-panel name=${t}>
          <div class="ph">
            <p class="tc-muted small m0">${desc}</p>
            ${this[toggleRow](key, 'Enable ' + label)}
            ${this[sliderRow](
              html`<k-slider class="col d-b ml" min="1" max="99" tooltip format="0%" .value=${String(this.thresholds[t])}
                @change=${e => this[setThreshold](t, Number(e.target.value))}></k-slider>`,
              html`<input type="text" inputmode="numeric" class="thresh-val mlh" .value=${display}
                @focus=${e => { this[editThreshold](t); e.target.select(); }}
                @blur=${e => this[commitThreshold](t, e.target.value)}
                @keydown=${e => { if (e.key === 'Enter') e.target.blur(); }}>`,
              true
            )}
          </div>
        </k-accordion-panel>`;
    };

    // A non-collapsible import card for one role, styled to match the detection-tier
    // accordion. Two header buttons add individual images or a whole folder to that set;
    // the body lists its sources. `mt` spaces it from the previous card (every call
    // site but the first passes it).
    this[sourceCard] = (set, title, hint, mt = false) => {
      const list = this.sources[set] || [];
      return html`
        <div class="b r ${mt ? 'mt' : ''}">
          <div class="row ai-c ph bb">
            <strong class="card-title col">${title}</strong>
            <span class="btn-grp">
              <button class="b pq tc-default" style="background:transparent!important" title="Add image(s)" @click=${() => this[addImages](set)}><k-icon name="photo_add"></k-icon></button>
              <button class="b pq tc-default" style="background:transparent!important" title="Add folder" @click=${() => this[addFolder](set)}><k-icon name="folder_add"></k-icon></button>
            </span>
          </div>
          <div class="ph">
            <p class="tc-muted small m0">${hint}</p>
            ${list.length ? list.map((s, i) => html`
              <div class="row ai-c nowrap mt">
                <k-icon class="tc-muted mrh" name=${s.kind === 'file' ? 'photo' : 'folder_open'}></k-icon>
                <span class="col ellipsis" title=${s.path}>${s.path.split(/[\\/]/).filter(Boolean).pop() || s.path}</span>
                <button class="no-btn tc-muted mlh" title="Remove" @click=${() => this[removeSource](set, i)}>&times;</button>
              </div>`) : html`<div class="tc-muted small mt">Nothing added yet</div>`}
          </div>
        </div>`;
    };

    /*
      Init Props
    */
    this.scanning = false;
    this.progress = null;
    this.editingTier = null;
  }

  /*
    Lifecycle Callbacks
  */
  connectedCallback() {
    super.connectedCallback();
    this[cfg] = getConfig(this);
    this[cfg]?.addEventListener('context:set', this.onConfigChange);
    this[cfg]?.addEventListener('context:create', this.onConfigChange);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this[cfg]?.removeEventListener('context:set', this.onConfigChange);
    this[cfg]?.removeEventListener('context:create', this.onConfigChange);
  }

  /*
    Protected Members
  */
  get settings() { return this[cfg]?.get('settings') ?? {}; }
  get thresholds() { return this[cfg]?.get('thresholds') ?? {}; }
  get sources() { return this[cfg]?.get('sources') ?? { reference: [], search: [] }; }

  /*
    Public Methods
  */
  // Entry points for the titlebar menu's "Add Folder / Add Images" (which target both sets).
  addImagesTo(set) { this[addImages](set); }
  addFolderTo(set) { this[addFolder](set); }

  /*
    Event Handlers
  */
  onConfigChange = () => this.requestUpdate();

  /*
    Rendering
  */
  render() {
    const scanDisabled = !this.scanning && this.sources.reference.length === 0 && this.sources.search.length === 0;
    return html`
      <div class="pane bg-alt">

        ${this[sourceCard]('reference', 'Reference Images', 'Known-good images — not compared to each other')}
        ${this[sourceCard]('search', 'Search Images', 'Images checked against the references', true)}

        <div class="mt">
          <h5 class="mbh">Detection Algorithms</h5>
          <k-accordion multiple persistent-id="dup-tiers" class="b r d-b ovf-h">
            ${this[tier]('usePhash', 'phash', 'tag', 'Perceptual hash',
              'Catches near-identical pixels — the same image re-saved, rescaled or recompressed, plus 90° rotations and mirror flips. Fast and exact, but it can\'t find crops or arbitrary rotations.')}
            ${this[tier]('useNN', 'nn', 'network_intelligence', 'Neural look-alikes',
              'A neural network (DINOv2) measures visual similarity, so it can spot edited or filtered versions. It also rates different photos of the same subject as similar — keep the threshold high so it only groups near-identical images.')}
            ${this[tier]('useGeo', 'geo', 'shapes', 'Geometric (ORB)',
              'Matches actual image content (keypoints + geometry), catching crops, rotations, scaling and watermarked copies of the same photo. The most reliable signal for true duplicates.')}
          </k-accordion>
        </div>

        <k-accordion persistent-id="dup-settings" class="b r d-b ovf-h mt">
          <k-accordion-header for-panel="settings" class="row ai-c ph">
            <k-icon name="settings" class="mrh mlq"></k-icon><strong>Settings</strong>
          </k-accordion-header>
          <k-accordion-panel name="settings">
            <div class="ph">
              ${this[toggleRow]('recursive', 'Include subfolders', false)}
              ${this[toggleRow]('preferGPU', 'Use GPU if available')}
              ${this[toggleRow]('confirmDelete', 'Confirm deletion')}
              <div class="mt">
                <span class="d-b mbq">Max images per dupe set</span>
                ${this[sliderRow](
                  html`<k-slider class="col d-b" min="2" max="30" tooltip .value=${String(this.settings.maxGroupSize)}
                    @change=${e => this[setSetting]('maxGroupSize', Number(e.target.value))}></k-slider>`,
                  html`<input type="text" inputmode="numeric" class="thresh-val mlh"
                    .value=${String(Math.round(this.settings.maxGroupSize))}
                    @focus=${e => e.target.select()}
                    @blur=${e => this[commitMaxGroup](e.target.value)}
                    @keydown=${e => { if (e.key === 'Enter') e.target.blur(); }}>`
                )}
              </div>
              <div class="row mt">
                <button class="danger small mrh" @click=${() => this[emit]('clear-cache')}>Clear cache</button>
                <button class="danger small" @click=${() => this[emit]('reset-settings')}>Reset settings</button>
              </div>
            </div>
          </k-accordion-panel>
        </k-accordion>

        <button class="${this.scanning ? 'danger' : 'primary'} full mt" ?disabled=${scanDisabled}
          @click=${() => this[emit](this.scanning ? 'cancel-scan' : 'start-scan')}>${this.scanning ? 'Cancel Scan' : 'Start Scan'}</button>

        ${this.progress ? html`
          <div class="mt">
            <k-progress class="full" percentage=${String(Math.round(this.progress.p * 100))} label></k-progress>
            <div class="tc-muted mt">${this.progress.text || ''}</div>
          </div>` : ''}
      </div>`;
  }

  // Shared utilities (.ai-c, .nowrap, .ovf-h …) cover the layout; only component-specific
  // bits remain: the heading size, the disabled-tier dim, the toggle's component vars, and
  // the borderless value input (which must beat kempo's input rule).
  static styles = [shared, css`
    .card-title { font-size: 1.15rem; }
    .tier-off { opacity: .55; }
    k-toggle {
      --switch_height: 1.35rem;
      --switch_width: 2.2rem;
      --handle_size__off: .75rem;
      --handle_size__on: 1.05rem;
      margin-bottom: 0;
    }
    .thresh-val {
      display: inline-block !important; width: 2.6rem !important; flex: 0 0 auto;
      font-variant-numeric: tabular-nums; font-weight: var(--fw_bold); text-align: right; color: inherit;
      background: transparent !important; border: 1px solid transparent !important; padding: 0 var(--spacer_q) !important;
      border-radius: var(--radius);
    }
    .thresh-val:not(:disabled):focus {
      background: var(--input_bg) !important; border-color: var(--c_input_border) !important;
    }
  `];
}

customElements.define('dup-controls', DupControls);
