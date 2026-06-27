import ShadowComponent from '/modules/kempo-ui/dist/components/ShadowComponent.js';
import { html, css } from '/modules/kempo-ui/dist/lit-all.min.js';

/*
  Utility Functions
*/
// Per-tier icon for the score widget.
const TIER_ICON = { phash: 'tag', nn: 'network_intelligence', geo: 'shapes' };

export default class Scores extends ShadowComponent {
  /*
    Reactive Properties / Attributes
  */
  static properties = {
    scores: { type: Array }
  };

  /*
    Constructor
  */
  constructor() {
    super();

    /*
      Init Props
    */
    this.scores = [];
  }

  /*
    Rendering
  */
  // Per-tier scores: icon + %, separated by | . Green (tc-success) if that tier
  // contributed to the grouping, muted otherwise.
  render() {
    return html`${this.scores.map((sig, k) => html`
      ${k ? html`<span class="tc-muted mxq">|</span>` : ''}
      <span class="d-if ai-c ${sig.contributed ? 'tc-success' : 'tc-muted'}">
        <k-icon name=${TIER_ICON[sig.tier]} class="mrq"></k-icon>${Math.round(sig.score * 100)}%
      </span>`)}`;
  }
  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      font-variant-numeric: tabular-nums;
      vertical-align: middle;
    }
    .ai-c {
      align-items: center;
    }
  `;
}

customElements.define('id-scores', Scores);
