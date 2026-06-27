import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import '/modules/kempo-ui/dist/components/Toggle.js';
import './SliderInput.js';

// An enable toggle + labelled slider/input — the "Enable <tier>" + threshold row
// repeated for each detection tier.
export default class ToggleSlider extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    label: { type: String },
    checked: { type: Boolean },
    min: { type: Number },
    max: { type: Number },
    step: { type: Number },
    value: { type: Number },
    format: { type: String }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Init Props
    */
    this.label = '';
    this.checked = false;
    this.min = 0;
    this.max = 100;
    this.step = 1;
    this.value = 0;
    this.format = 'integer';
  }

  /*
    Event Handlers
  */
  onToggle = e => this.dispatchEvent(new CustomEvent('toggle', { detail: { checked: e.detail.value } }));
  onSliderChange = e => this.dispatchEvent(new CustomEvent('change', { detail: { value: e.detail.value } }));

  /*
    Rendering
  */
  render() {
    return html`
      <div class="row ai-c">
        <k-toggle .value=${this.checked} @change=${this.onToggle}></k-toggle>
        <span class="mlh">${this.label}</span>
      </div>
      <id-slider-input class="mt" min=${this.min} max=${this.max} step=${this.step} .value=${this.value} format=${this.format}
        @change=${this.onSliderChange}></id-slider-input>`;
  }

  // Only what kempo-css can't express: the row layout and the toggle's component vars.
  static styles = css`
    :host {
      display: block;
    }
    .ai-c {
      align-items: center;
    }
    k-toggle {
      --switch_height: 1.35rem;
      --switch_width: 2.2rem;
      --handle_size__off: .75rem;
      --handle_size__on: 1.05rem;
      margin-bottom: 0;
    }
  `;
}

customElements.define('id-toggle-slider', ToggleSlider);
