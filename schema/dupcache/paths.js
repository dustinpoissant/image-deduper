// One row per file path ever scanned, pointing at its content hash — accumulates across scans
// (see lib/engine.js's gcCache) rather than being scoped to just the current scan, so a folder
// that isn't part of a given run still counts as referenced and its cached work isn't thrown
// away.
export default {
  path: { type: 'text', primary: true },
  size: { type: 'integer' },
  mtime: { type: 'real' },
  hash: { type: 'text' },
};

export const version = 1;
