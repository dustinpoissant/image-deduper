// User-confirmed "these are not duplicates" decisions, keyed the same way as orbcache (the
// pair's two content hashes joined with "|") — clustering must never re-link two images
// carrying this relationship, even transitively through a third image (see clusterPairs).
export default {
  pair: { type: 'text', primary: true },
};

export const version = 1;
