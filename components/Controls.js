import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import '/modules/kempo-ui/dist/components/Toggle.js';
import '/modules/kempo-ui/dist/components/Progress.js';
import '/modules/kempo-ui/dist/components/Accordion.js';
import { shared } from '/lib/styles.js';
import { getConfig } from '/lib/contexts.js';
import api from '/lib/api.js';
import './SourceCard.js';
import './ToggleSlider.js';
import './SliderInput.js';

/*
  Symbols
*/
const cfg = Symbol('cfg');
const emit = Symbol('emit');
const setSetting = Symbol('setSetting');
const setThreshold = Symbol('setThreshold');
const addImages = Symbol('addImages');
const addFolder = Symbol('addFolder');
const addSources = Symbol('addSources');
const removeSource = Symbol('removeSource');
const toggleRow = Symbol('toggleRow');
const tier = Symbol('tier');

export default class Controls extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    // Transient scan state, owned by the app and passed down.
    scanning: { type: Boolean },
    progress: { type: Object }
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

    // A detection tier as an accordion section: icon + name in the header; description,
    // enable toggle and threshold slider revealed inside the panel. All three tiers'
    // raw scores are remapped (lib/engine.js) onto the same 1-100% confidence scale, so
    // one whole-percent step works for all of them.
    this[tier] = (key, t, icon, label, desc) => {
      const off = !this.settings[key];
      return html`
        <k-accordion-header for-panel=${t} class="row ai-c ph ${off ? 'tier-off' : ''}">
          <k-icon name=${icon} class="mrh mlq"></k-icon><strong class=${off ? 'td-lt' : ''}>${label}</strong>
        </k-accordion-header>
        <k-accordion-panel name=${t}>
          <div class="ph">
            <p class="tc-muted small mbh">${desc}</p>
            <id-toggle-slider label=${'Enable ' + label} .checked=${this.settings[key]} min="1" max="100"
              .value=${this.thresholds[t]} format="percent"
              @toggle=${e => this[setSetting](key, e.detail.checked)}
              @change=${e => this[setThreshold](t, e.detail.value)}></id-toggle-slider>
          </div>
        </k-accordion-panel>`;
    };

    /*
      Init Props
    */
    this.scanning = false;
    this.progress = null;
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

        <id-source-card label="Reference Images" hint="Known-good images — not compared to each other"
          .sources=${this.sources.reference}
          @add-images=${() => this[addImages]('reference')}
          @add-folder=${() => this[addFolder]('reference')}
          @remove=${e => this[removeSource]('reference', e.detail.index)}></id-source-card>
        <id-source-card class="mt" label="Search Images" hint="Images checked against the references"
          .sources=${this.sources.search}
          @add-images=${() => this[addImages]('search')}
          @add-folder=${() => this[addFolder]('search')}
          @remove=${e => this[removeSource]('search', e.detail.index)}></id-source-card>

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
              ${this[toggleRow]('deprioritizeScreenshots', 'Auto Delete: prefer to keep originals over screenshots')}
              <div class="mt">
                <span class="d-b mbq">Max images per dupe set</span>
                <id-slider-input min="2" max="30" .value=${this.settings.maxGroupSize} format="integer"
                  @change=${e => this[setSetting]('maxGroupSize', e.detail.value)}></id-slider-input>
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

  // Shared utilities (.ai-c, .ovf-h …) cover the layout; only component-specific bits
  // remain: the heading size, the disabled-tier dim, and the toggle's component vars
  // (the toggle-slider component carries its own copy for its own toggle instances).
  static styles = [shared, css`
    .tier-off {
      opacity: .55;
    }
    k-toggle {
      --switch_height: 1.35rem;
      --switch_width: 2.2rem;
      --handle_size__off: .75rem;
      --handle_size__on: 1.05rem;
      margin-bottom: 0;
    }
  `];
}

customElements.define('id-controls', Controls);
