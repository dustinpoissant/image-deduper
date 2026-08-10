// Cached geometric (ORB) match scores, keyed by the pair's two content hashes joined with "|"
// (see lib/engine.js's pairKey) — so a pair already geometrically verified in a past scan
// doesn't need the expensive worker round-trip again.
export default {
  pair: { type: 'text', primary: true },
  score: { type: 'real' },
};

export const version = 1;
