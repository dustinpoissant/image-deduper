import { css } from '/modules/kempo-ui/dist/lit-all.min.js';

// Small utilities reused across the dup-* components (kempo-css covers the rest:
// .primary, .link, .small, spacing, etc. are auto-injected into each shadow root).
export const shared = css`
  :host { display: block; }
  .muted { opacity: .65; font-size: .85em; }
  .small { font-size: .8em; }
  .stack > * + * { margin-top: var(--spacer); }
  .row-between { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
  .grow { flex: 1; min-width: 0; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wfull { width: 100%; }
  /* leaf pane becomes its own scroll container (k-split panes have min-height:auto).
     100vh would overflow by the titlebar's height since it ignores layout context. */
  .pane { height: calc(100vh - var(--app-titlebar-height, 0px)); box-sizing: border-box; overflow-y: auto; overflow-x: hidden; padding: var(--spacer); }
`;
