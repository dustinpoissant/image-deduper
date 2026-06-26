import { css } from '/modules/kempo-ui/dist/lit-all.min.js';

// Utility classes that extend kempo-css with the few things it has no helper for yet.
// Named in the kempo style so they can be lifted straight into the framework. Everything
// else in the components uses real kempo-css utilities: .row/.col/.span-*, .p*/.m* (incl.
// negative -m*), .b/.bb/.r, .tc-*, .bg-*, .d-*, .full, .small, .td-lt, etc.
export const shared = css`
  :host { display: block; }

  /* Flex alignment — kempo ships .row/.col/.span-* but no align-items/justify utilities. */
  .ai-c { align-items: center; }
  .ai-s { align-items: flex-start; }
  .jc-b { justify-content: space-between; }
  .jc-e { justify-content: flex-end; }
  .nowrap { flex-wrap: nowrap !important; }

  /* Auto-fill css-grid — kempo's .cols-N are fixed counts; this fills columns by a min
     width (set --col-min) and spaces them with the standard spacer. */
  .grid-fill { display: grid; gap: var(--spacer); grid-template-columns: repeat(auto-fill, minmax(var(--col-min, 16rem), 1fr)); }

  .ovf-h { overflow: hidden; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }

  /* App scroll pane — the titlebar-aware height + own scroll context isn't expressible
     as a single kempo utility. */
  .pane { height: calc(100vh - var(--app-titlebar-height, 0px)); box-sizing: border-box; overflow-y: auto; overflow-x: hidden; padding: var(--spacer); }
`;
