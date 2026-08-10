// Per-content-hash feature cache — one row per distinct file (by SHA-256 of its bytes), shared
// by every path that happens to have identical bytes. sscd/sscdModel landed after this table
// was already in the wild; they're declared here from the start now, so kempo-app's own
// schema auto-migration (ALTER TABLE ADD COLUMN for anyone with an older cache) handles what
// lib/engine.js's initCache used to do by hand via a sqlite_master.sql inspection.
export default {
  hash: { type: 'text', primary: true },
  phash: { type: 'text' },
  embedding: { type: 'text' },
  model: { type: 'text' },
  w: { type: 'integer' },
  h: { type: 'integer' },
  sscd: { type: 'text' },
  sscdModel: { type: 'text' },
};

export const version = 1;
