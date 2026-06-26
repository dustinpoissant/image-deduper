import closestAcrossShadow from '/modules/kempo-ui/dist/utils/closestAcrossShadow.js';

// App-level state lives in two k-context elements that wrap <dup-app> in the page
// (see pages/index.html). Components — even nested inside dup-app's shadow root —
// reach them with closestAcrossShadow, which native closest() can't do.
//
//   dup-config  (persistent-id, auto-saved to localStorage): settings, thresholds, sources
//   dup-ui      (transient): selectedId
export const getConfig = el => closestAcrossShadow(el, 'k-context[persistent-id="dup-config"]');
export const getUI = el => closestAcrossShadow(el, 'k-context.dup-ui');
