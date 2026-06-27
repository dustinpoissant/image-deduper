/**
 * Detection orchestration helpers (renderer side, no DOM).
 * Pure math + the ORB Web Worker manager + the SQLite cache helpers.
 * UI components import from here so the Lit components stay presentational.
 */

const apiCall = (name, ...args) => window.api.call(name, ...args);
const sqlQ = (q) => window.api.sqlQuery('dupcache', q);

/* ---------- math / similarity ---------- */

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const fmtBytes = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';

// Normalized cache key for a content-hash pair, shared by orbcache and excluded_pairs.
export const pairKey = (hashA, hashB) => (hashA < hashB ? hashA + '|' + hashB : hashB + '|' + hashA);

const POP = {};
for (let i = 0; i < 16; i++) { let c = 0, n = i; while (n) { c += n & 1; n >>= 1; } POP[i.toString(16)] = c; }
export function hamHex(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += POP[(parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16)]; return d; }
export function phashSim(A, B) { let best = 64; for (const h of B) best = Math.min(best, hamHex(A[0], h)); return 1 - best / 64; }
export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Re-map each raw signal onto a "confidence it's a duplicate" scale where 0% means
// confidently different, 100% means confidently the same, and 50% is the actual
// decision boundary — the raw value where it's genuinely a coin flip. That makes 50%
// a sane default threshold for every tier, rather than each tier needing its own
// hand-tuned number on an otherwise-meaningless 0-100 scale.
// Two linear segments meeting at `mid` (raw value -> 0.5) instead of one floor-to-ceiling
// line, since the gap between "confidently different" and "the boundary" isn't
// necessarily the same width (in raw units) as the gap between the boundary and
// "confidently the same".
const remapTri = (raw, lo, mid, hi) => {
  if (raw <= lo) return 0;
  if (raw >= hi) return 1;
  return raw < mid ? 0.5 * (raw - lo) / (mid - lo) : 0.5 + 0.5 * (raw - mid) / (hi - mid);
};
// Embedding cosine: 0.45 floor (weakest candidate worth a look) was the old "0%";
// 0.99 ceiling (near-identical images) was the old "100%". The boundary started at
// cos ≈0.936 (the old default of 90%), but that let through a real false positive —
// two different white sports coupes (toyota-celica vs nissan-370z) scored 51.7%, and
// real-world testing independently found the same thing needing 52% before it cleared.
// Nudged to ≈0.938, where that pair lands just under 50% instead of just over it.
export const remapEmbed = (cos) => remapTri(cos, 0.45, 0.93816, 0.99);
// Perceptual hash similarity: same idea — old floor 0.55/ceiling 1.0, old default of
// 60% put the boundary at sim ≈0.82.
export const remapPhash = (sim) => remapTri(sim, 0.55, 0.82, 1.0);
// ORB raw is the RANSAC inlier ratio. Measured directly against example/ (11200 pairs,
// 1680 ORB-verified): coincidental texture matches between unrelated images never
// exceeded 0.0135, while real matches start as low as 0.037 — a >2x clean gap with zero
// observed overlap, nothing like the floor of 0.15 originally guessed. That floor was
// silently throwing away genuine signal: rotated/zoomed duplicates routinely score
// 0.04-0.3 raw (real geometric overlap, just less of it), which used to map to a flat
// 0%. Anchored just above the measured negative ceiling instead, with margin for photos
// this exact set didn't cover.
export const remapOrb = (orb) => remapTri(orb, 0.013, 0.03, 1.0);

/* ---------- candidate pairs + clustering ---------- */

// Sparse pairwise signals, keeping only candidates above a low floor — *if* phash or the
// neural embedding actually ran. With both disabled (Geometric running solo), there's no
// cheap signal to filter on, so every valid pair has to go through as a candidate instead
// of silently producing zero — Geometric is then the only thing deciding what's a match.
// Role-aware: when any image is a reference (item.ref), only Reference×Search pairs are
// built (each reference vs each search image) — Ref×Ref and Search×Search are skipped, so
// a small reference set against a huge search set costs R*S comparisons instead of N²/2.
// With no reference present it falls back to all-pairs among the search images (legacy).
export function buildCandidatePairs(items, settings = {}) {
  const { usePhash = true, useNN = true } = settings;
  const cheapSignal = usePhash || useNN;
  const n = items.length, pairs = [];
  const refMode = items.some(it => it.ref);
  const include = (a, b) => refMode
    ? ((a.ref && b.search) || (a.search && b.ref))
    : (a.search && b.search);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!include(items[i], items[j])) continue;
      let sEmbed = 0, sPhash = 0;
      if (items[i].embedding && items[j].embedding) sEmbed = remapEmbed(cosine(items[i].embedding, items[j].embedding));
      if (items[i].phash && items[j].phash) sPhash = remapPhash(phashSim(items[i].phash, items[j].phash));
      if (!cheapSignal || Math.max(sEmbed, sPhash) >= 0.12) pairs.push({ i, j, sEmbed, sPhash, sOrb: null });
    }
  }
  return pairs;
}

// Each enabled tier has its OWN threshold (s.tPhash / s.tNN / s.tGeo, all 0..1).
// A pair links a set if ANY enabled tier clears its threshold. Keeping the neural
// threshold high lets it group only near-identical images instead of "same subject".
export function pairLinks(p, s) {
  if (s.usePhash && p.sPhash >= s.tPhash) return true;
  if (s.useGeo && p.sOrb != null && p.sOrb >= s.tGeo) return true;
  if (s.useNN && p.sEmbed >= s.tNN) return true;
  return false;
}

// Strongest signal among enabled tiers, for display.
export function pairBest(p, s) {
  let v = 0;
  if (s.usePhash) v = Math.max(v, p.sPhash);
  if (s.useGeo && p.sOrb != null) v = Math.max(v, p.sOrb);
  if (s.useNN) v = Math.max(v, p.sEmbed);
  return v;
}

// Union-find clustering of candidate pairs above the confidence threshold.
const TIERS = [
  ['phash', 'usePhash', 'tPhash'],
  ['nn', 'useNN', 'tNN'],
  ['geo', 'useGeo', 'tGeo']
];
const sigOf = { phash: (p) => p.sPhash, nn: (p) => p.sEmbed, geo: (p) => (p.sOrb == null ? 0 : p.sOrb) };

// excluded: Set of pairKey(hashA,hashB) the user has explicitly marked as not-duplicates.
// Two images carrying such a relationship must never end up in the same group, even via
// a transitive third image. Links are merged strongest-first, so when image C matches
// both A and B (and A!=B), whichever of A/B is the *closer* match to its group wins —
// the weaker link is skipped rather than forcing a conflicting three-way merge.
export function clusterPairs(items, pairs, s, excluded = new Set()) {
  const n = items.length;
  const maxGroupSize = s.maxGroupSize || 10;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

  const hashesOf = new Map();
  const size = new Array(n).fill(1);
  for (let i = 0; i < n; i++) hashesOf.set(i, new Set([items[i].hash]));

  // Reference images are guaranteed non-duplicates of each other (buildCandidatePairs
  // never builds Ref×Ref pairs), but the union-find here is transitive — two
  // references that each independently match the same ambiguous search image would
  // otherwise still end up merged through it. Tracked the same way as `excluded`
  // conflicts: reject a merge that would combine two references, so (processing
  // strongest links first) the weaker match just loses the contested image instead.
  const refsOf = new Map();
  for (let i = 0; i < n; i++) refsOf.set(i, items[i].ref ? new Set([i]) : new Set());

  const conflicts = (rootA, rootB) => {
    for (const a of hashesOf.get(rootA)) for (const b of hashesOf.get(rootB)) if (excluded.has(pairKey(a, b))) return true;
    return false;
  };

  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return true;
    if (size[a] + size[b] > maxGroupSize) return false;
    if (refsOf.get(a).size + refsOf.get(b).size > 1) return false;
    if (excluded.size && conflicts(a, b)) return false;
    parent[a] = b;
    size[b] += size[a];
    refsOf.set(b, new Set([...refsOf.get(a), ...refsOf.get(b)]));
    refsOf.delete(a);
    if (excluded.size) {
      const merged = new Set([...hashesOf.get(a), ...hashesOf.get(b)]);
      hashesOf.delete(a);
      hashesOf.set(b, merged);
    }
    return true;
  };

  // Strongest links merge first, so once a group hits the cap it's the weakest
  // links to it that get dropped rather than an arbitrary later-processed one.
  const linked = pairs.filter(p => pairLinks(p, s)).sort((a, b) => pairBest(b, s) - pairBest(a, s));
  for (const p of linked) union(p.i, p.j);

  // Per-component aggregates: best score per tier + whether that tier cleared its
  // threshold for some in-group pair (i.e. contributed to the grouping).
  const agg = new Map(); // root -> { phash, nn, geo, cphash, cnn, cgeo }
  for (const p of pairs) {
    const r = find(p.i);
    if (r !== find(p.j)) continue;
    let d = agg.get(r);
    if (!d) { d = { phash: 0, nn: 0, geo: 0, cphash: false, cnn: false, cgeo: false }; agg.set(r, d); }
    for (const [tier, useKey, tKey] of TIERS) {
      if (!s[useKey]) continue;
      const v = sigOf[tier](p);
      if (v > d[tier]) d[tier] = v;
      if (v >= s[tKey] && !(tier === 'geo' && p.sOrb == null)) d['c' + tier] = true;
    }
  }

  const buckets = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(i); }

  const groups = [];
  let gid = 0;
  for (const [root, members] of buckets) {
    if (members.length < 2) continue;
    const d = agg.get(root) || { phash: 0, nn: 0, geo: 0, cphash: false, cnn: false, cgeo: false };
    const signals = [];
    for (const [tier, useKey] of TIERS) {
      if (s[useKey]) signals.push({ tier, score: d[tier], contributed: d['c' + tier] });
    }
    const best = signals.reduce((m, x) => Math.max(m, x.score), 0);
    groups.push({ id: gid++, members: members.slice(), best, signals });
  }
  groups.sort((a, b) => b.best - a.best || b.members.length - a.members.length);
  return groups;
}

/* ---------- Tier 3: ORB geometric verification (Web Worker) ----------
   OpenCV-JS blocks whatever thread it runs on, so it lives in a dedicated worker:
   the UI never freezes, and a stuck init just times out and disables the tier. */
const ORB_WORKER_SRC = `
  let cv = null, ready = false;
  const cache = {};
  function build(id, w, h, bytes) {
    const mat = cv.matFromArray(h, w, cv.CV_8UC1, Array.from(bytes));
    const orb = new cv.ORB(800), kp = new cv.KeyPointVector(), des = new cv.Mat(), nm = new cv.Mat();
    orb.detectAndCompute(mat, nm, kp, des);
    const n = kp.size(), kpx = new Float32Array(n), kpy = new Float32Array(n);
    for (let i = 0; i < n; i++) { const p = kp.get(i).pt; kpx[i] = p.x; kpy[i] = p.y; }
    mat.delete(); orb.delete(); kp.delete(); nm.delete();
    cache[id] = { des, kpx, kpy, count: n };
  }
  function match(aId, bId) {
    const A = cache[aId], B = cache[bId];
    if (!A || !B || A.count < 8 || B.count < 8) return 0;
    const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), knn = new cv.DMatchVectorVector();
    bf.knnMatch(A.des, B.des, knn, 2);
    const gi = [], gj = [];
    for (let i = 0; i < knn.size(); i++) { const m = knn.get(i); if (m.size() < 2) continue; const a = m.get(0), b = m.get(1); if (a.distance < 0.75 * b.distance) { gi.push(a.queryIdx); gj.push(a.trainIdx); } }
    knn.delete(); bf.delete();
    const denom = Math.min(A.count, B.count);
    if (gi.length < 8) return gi.length / Math.max(denom, 8);
    const src = [], dst = [];
    for (let k = 0; k < gi.length; k++) { src.push(A.kpx[gi[k]], A.kpy[gi[k]]); dst.push(B.kpx[gj[k]], B.kpy[gj[k]]); }
    const sm = cv.matFromArray(gi.length, 1, cv.CV_32FC2, src), dm = cv.matFromArray(gi.length, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
    const H = cv.findHomography(sm, dm, cv.RANSAC, 5, mask);
    let inl = 0; for (let i = 0; i < mask.rows; i++) inl += mask.data[i];
    sm.delete(); dm.delete(); mask.delete(); try { H.delete(); } catch (e) {}
    return Math.max(0, Math.min(1, inl / denom));
  }
  self.onmessage = (e) => {
    const d = e.data;
    try {
      if (d.type === 'init') { importScripts(d.url); const c = self.cv; const go = () => { cv = self.cv; ready = true; postMessage({ type: 'ready' }); }; if (c && c.Mat) go(); else if (c) c.onRuntimeInitialized = go; else postMessage({ type: 'error', error: 'no cv global' }); return; }
      if (!ready) return postMessage({ type: 'error', error: 'not ready' });
      if (d.type === 'add') { if (!cache[d.id]) build(d.id, d.w, d.h, d.bytes); postMessage({ type: 'added', id: d.id }); return; }
      if (d.type === 'match') { let s = null; try { s = match(d.a, d.b); } catch (err) { s = null; } postMessage({ type: 'matched', rid: d.rid, score: s }); return; }
      if (d.type === 'clear') { for (const k in cache) { try { cache[k].des.delete(); } catch (e) {} delete cache[k]; } postMessage({ type: 'cleared' }); return; }
    } catch (err) { postMessage({ type: 'error', error: String(err && err.message || err) }); }
  };
`;

const withTimeout = (p, ms, fb) => Promise.race([p, new Promise((r) => setTimeout(() => r(fb), ms))]);

// Each match() is an independent round-trip (knn match + RANSAC), so a pool of
// workers lets the geometric tier actually use more than one core instead of
// verifying thousands of border pairs strictly one at a time.
export class OrbMatcher {
  constructor(poolSize) {
    this.poolSize = poolSize || Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    this.workers = []; // slot per worker: { worker, added, pendingAdd, pendingMatch }
    this.init = null; this.failed = false; this.rid = 0;
  }

  ensure() {
    if (this.failed) return Promise.reject(new Error('orb unavailable'));
    if (this.init) return this.init;
    this.init = Promise.all(Array.from({ length: this.poolSize }, (_, idx) => this.#spawnWorker(idx)))
      .catch((e) => { this.failed = true; throw e; });
    return this.init;
  }

  #spawnWorker(idx) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(URL.createObjectURL(new Blob([ORB_WORKER_SRC], { type: 'application/javascript' }))); }
      catch (e) { return reject(e); }
      const slot = { worker: w, added: new Set(), pendingAdd: new Map(), pendingMatch: new Map() };
      const t = setTimeout(() => reject(new Error('orb init timeout')), 30000);
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') { clearTimeout(t); this.workers[idx] = slot; resolve(); }
        else if (d.type === 'error') { clearTimeout(t); reject(new Error(d.error)); }
        else if (d.type === 'added') { const r = slot.pendingAdd.get(d.id); if (r) { slot.pendingAdd.delete(d.id); r(); } }
        else if (d.type === 'matched') { const r = slot.pendingMatch.get(d.rid); if (r) { slot.pendingMatch.delete(d.rid); r(d.score); } }
      };
      w.onerror = () => { clearTimeout(t); reject(new Error('worker error')); };
      w.postMessage({ type: 'init', url: location.origin + '/modules/@techstark/opencv-js/dist/opencv.js' });
    });
  }

  async #ensureAdded(idx, path) {
    const slot = this.workers[idx];
    if (slot.added.has(path)) return;
    const g = await apiCall('grayBuffer', path, 512);
    if (!g) { slot.added.add(path); return; }
    const bin = atob(g.data); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await new Promise((res) => { slot.pendingAdd.set(path, res); slot.worker.postMessage({ type: 'add', id: path, w: g.width, h: g.height, bytes }, [bytes.buffer]); });
    slot.added.add(path);
  }

  async #matchOn(idx, pathA, pathB) {
    const slot = this.workers[idx];
    await this.#ensureAdded(idx, pathA); await this.#ensureAdded(idx, pathB);
    const rid = ++this.rid;
    return await new Promise((res) => { slot.pendingMatch.set(rid, res); slot.worker.postMessage({ type: 'match', a: pathA, b: pathB, rid }); });
  }

  // Geometric similarity in [0,1] (raw RANSAC inlier ratio), or null if unavailable.
  async match(pathA, pathB) {
    try {
      await this.ensure();
      return await withTimeout(this.#matchOn(0, pathA, pathB), 20000, null);
    } catch {
      return null;
    }
  }

  // Distribute many independent {pathA,pathB} jobs across the whole worker pool.
  // getPair(job) -> [pathA, pathB]; onEach(index, score, job) fires as each completes.
  // shouldStop(), if given, is polled before claiming each new job so a cancelled
  // scan stops promptly instead of draining the whole queue.
  async matchAll(jobs, getPair, onEach, shouldStop) {
    await this.ensure();
    let next = 0;
    const results = new Array(jobs.length);
    const runWorker = async (idx) => {
      for (;;) {
        if (shouldStop && shouldStop()) return;
        const i = next++;
        if (i >= jobs.length) return;
        const [a, b] = getPair(jobs[i]);
        let score;
        try { score = await withTimeout(this.#matchOn(idx, a, b), 20000, null); }
        catch { score = null; }
        results[i] = score;
        if (onEach) onEach(i, score, jobs[i]);
      }
    };
    await Promise.all(this.workers.map((_, idx) => runWorker(idx)));
    return results;
  }

  dispose() {
    for (const slot of this.workers) {
      if (!slot) continue;
      slot.added.clear(); slot.pendingAdd.clear(); slot.pendingMatch.clear();
      try { slot.worker.postMessage({ type: 'clear' }); } catch (e) {}
    }
  }
}

/* ---------- persistent cache (SQLite via kempo-app) ---------- */

const esc = (v) => v == null ? 'NULL' : (typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`);
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

let _cacheReady = null;
export function initCache() {
  if (!_cacheReady) _cacheReady = (async () => {
    await sqlQ('CREATE TABLE IF NOT EXISTS images (hash TEXT PRIMARY KEY, phash TEXT, embedding TEXT, model TEXT, w INTEGER, h INTEGER)');
    await sqlQ('CREATE TABLE IF NOT EXISTS paths (path TEXT PRIMARY KEY, size INTEGER, mtime REAL, hash TEXT)');
    await sqlQ('CREATE TABLE IF NOT EXISTS orbcache (pair TEXT PRIMARY KEY, score REAL)');
    await sqlQ('CREATE TABLE IF NOT EXISTS excluded_pairs (pair TEXT PRIMARY KEY)');
  })();
  return _cacheReady;
}

export function embToB64(arr) { const u8 = new Uint8Array(Float32Array.from(arr).buffer); let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
export function b64ToEmb(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return Array.from(new Float32Array(u8.buffer)); }

export async function selectIn(table, cols, keyCol, keys) {
  const map = new Map();
  for (const part of chunk([...new Set(keys)], 300)) {
    if (!part.length) continue;
    const rows = await sqlQ(`SELECT ${cols} FROM ${table} WHERE ${keyCol} IN (${part.map(esc).join(',')})`);
    for (const r of rows) map.set(r[keyCol], r);
  }
  return map;
}

// Full set of confirmed not-duplicate pair keys. Needed (not just a lookup by candidate
// pair) because clusterPairs must catch *transitive* conflicts — e.g. A!=B is never a
// candidate pair itself if A and B aren't directly similar, only reachable via a third
// image C that matches both.
export async function getExcludedPairs() {
  await initCache();
  const rows = await sqlQ('SELECT pair FROM excluded_pairs');
  return new Set(rows.map(r => r.pair));
}

export async function bulkUpsert(table, cols, rows) {
  for (const part of chunk(rows, 200)) {
    if (!part.length) continue;
    const values = part.map(r => `(${cols.map(c => esc(r[c])).join(',')})`).join(',');
    await sqlQ(`INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES ${values}`);
  }
}

export async function clearCache() {
  await initCache();
  await sqlQ('DELETE FROM images'); await sqlQ('DELETE FROM paths'); await sqlQ('DELETE FROM orbcache');
  await sqlQ('DELETE FROM excluded_pairs');
}

/**
 * Drop a deleted file from the cache. Always removes its path row; removes the
 * content-hash features + its orb comparisons only when nothing else uses that hash.
 */
export async function removeFromCache(path, hash, deleteHash) {
  await sqlQ(`DELETE FROM paths WHERE path = ${esc(path)}`);
  if (deleteHash && hash) {
    await sqlQ(`DELETE FROM images WHERE hash = ${esc(hash)}`);
    await sqlQ(`DELETE FROM orbcache WHERE pair LIKE ${esc(hash + '|%')} OR pair LIKE ${esc('%|' + hash)}`);
    await sqlQ(`DELETE FROM excluded_pairs WHERE pair LIKE ${esc(hash + '|%')} OR pair LIKE ${esc('%|' + hash)}`);
  }
}

// Mark every pairwise combination among these content hashes as confirmed-not-duplicates,
// so future scans never link or geometrically compare them again.
export async function markNotDuplicates(hashes) {
  await initCache();
  const rows = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) rows.push({ pair: pairKey(hashes[i], hashes[j]) });
  }
  await bulkUpsert('excluded_pairs', ['pair'], rows);
}

/* ---------- thumbnails (cached) ---------- */

const _thumbs = new Map();
export async function thumbnail(path, size) {
  const key = `${path}@${size}`;
  if (_thumbs.has(key)) return _thumbs.get(key);
  const t = await apiCall('thumbnail', path, size);
  _thumbs.set(key, t);
  return t;
}
