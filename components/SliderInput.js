import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';
import '/modules/kempo-ui/dist/components/Slider.js';

/*
  Symbols
*/
const commit = Symbol('commit');

// A slider paired with an editable value box — used for any min/max numeric setting.
// `format` controls only the display suffix ('percent' shows "70%", anything else
// shows the bare integer); the underlying value is always a plain number.
export default class SliderInput extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    min: { type: Number },
    max: { type: Number },
    value: { type: Number },
    format: { type: String },
    // The input shows a bare number while focused, the formatted display otherwise.
    editing: { state: true }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Private Methods
    */
    // Clamp/round to range, write it, then drop back to the formatted display.
    this[commit] = raw => {
      this.editing = false;
      const n = typeof raw === 'number' ? raw : parseFloat(raw);
      this.value = Number.isFinite(n) ? Math.min(this.max, Math.max(this.min, Math.round(n))) : Math.round(this.value);
      this.dispatchEvent(new CustomEvent('change', { detail: { value: this.value } }));
    };

    /*
      Init Props
    */
    this.min = 0;
    this.max = 100;
    this.value = 0;
    this.format = 'integer';
    this.editing = false;
  }

  /*
    Event Handlers
  */
  onSliderChange = e => this[commit](Number(e.target.value));
  onFocus = e => { this.editing = true; e.target.select(); };
  onBlur = e => this[commit](e.target.value);
  onKeydown = e => { if (e.key === 'Enter') e.target.blur(); };

  /*
    Rendering
  */
  render() {
    const rounded = Math.round(this.value);
    const display = this.editing ? String(rounded) : this.format === 'percent' ? `${rounded}%` : String(rounded);
    return html`
      <k-slider class="col d-b" min=${this.min} max=${this.max} tooltip .format=${this.format === 'percent' ? '0%' : null}
        .value=${String(this.value)} @change=${this.onSliderChange}></k-slider>
      <input type="text" inputmode="numeric" class="val mlh" .value=${display}
        @focus=${this.onFocus} @blur=${this.onBlur} @keydown=${this.onKeydown}>`;
  }

  // Only what kempo-css can't express: the borderless value input (must beat kempo's
  // input rule) and the row layout.
  static styles = css`
    :host {
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      padding-left: var(--spacer_h, 0.5rem);
    }
    .val {
      display: inline-block !important;
      width: 2.6rem !important;
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      font-weight: var(--fw_bold);
      text-align: right;
      color: inherit;
      background: transparent !important;
      border: 1px solid transparent !important;
      padding: 0 var(--spacer_q) !important;
      border-radius: var(--radius);
    }
    .val:not(:disabled):focus {
      background: var(--input_bg) !important;
      border-color: var(--c_input_border) !important;
    }
  `;
}

customElements.define('id-slider-input', SliderInput);
