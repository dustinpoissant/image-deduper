/**
 * Detection orchestration helpers (renderer side, no DOM).
 * Pure math + the ORB Web Worker manager + the SQLite cache helpers.
 * UI components import from here so the Lit components stay presentational.
 */

const apiCall = (name, ...args) => window.api.call(name, ...args);
const sqlQ = (q, params) => window.api.sqlQuery('dupcache', q, params);
// Runs a batch of { sql, params } statements as one all-or-nothing transaction.
const sqlTx = (statements) => window.api.sqlTransaction('dupcache', statements);

/* ---------- math / similarity ---------- */

export const clamp01 = (x) => Math.max(0, Math.min(1, x));
export const fmtBytes = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB';

// Normalized cache key for a content-hash pair, shared by orbcache and excluded_pairs.
export const pairKey = (hashA, hashB) => (hashA < hashB ? hashA + '|' + hashB : hashB + '|' + hashA);

const POP = {};
for (let i = 0; i < 16; i++) { let c = 0, n = i; while (n) { c += n & 1; n >>= 1; } POP[i.toString(16)] = c; }
export function hamHex(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += POP[(parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16)]; return d; }
// A pHash payload is either the legacy `string[8]` or the current `{ hashes, detail }`.
// Normalizing here keeps rows cached by older versions valid instead of forcing a
// full recompute; a legacy row simply reports unknown detail.
export const phashHashes = (v) => Array.isArray(v) ? v : (v && v.hashes) || null;
export const phashDetail = (v) => Array.isArray(v) ? null : (v && v.detail != null ? v.detail : null);

// Minimum contrast (std dev, 0-255) for a pHash to carry real information. Below this the
// image is effectively featureless and its bits are noise that happens to look like every
// other featureless image's. Unknown detail fails open so legacy rows behave as before.
export const PHASH_MIN_DETAIL = 6;
export const phashUsable = (v) => { const d = phashDetail(v); return d == null || d >= PHASH_MIN_DETAIL; };

// A[0] (identity) vs all 8 dihedral orientations of B — the dihedral group is closed, so
// this covers every relative orientation without needing 8x8 comparisons.
export function phashSim(A, B) {
  const a = phashHashes(A), b = phashHashes(B);
  if (!a || !b) return 0;
  let best = 64;
  for (const h of b) best = Math.min(best, hamHex(a[0], h));
  return 1 - best / 64;
}
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
// Perceptual hash similarity. Measured over example/ (11200 pairs, 240 true dupes):
// unrelated images do NOT bottom out near 0.5 as you'd expect from 64 random bits —
// taking the min Hamming distance across 8 dihedral orientations pulls their similarity
// up to a median of 0.594, p99 0.719, worst case 0.781. The old floor of 0.55 sat *below*
// that noise band, so every unrelated pair was handed 8-14% confidence it hadn't earned,
// and those inflated scores leaked past the candidate floor into the geometric tier.
// Anchoring the floor just above the measured worst non-duplicate (0.781) makes "no
// relationship" read as a true 0% and shrinks the candidate pool ~65% with zero recall
// change. The 0.82 boundary is kept: it still separates cleanly (worst non-dupe 0.781 vs
// the filter/flip/watermark duplicates at 0.90-1.00).
// Note this tier is genuinely blind to zoom (dupes 0.50-0.594) and arbitrary rotation
// (0.5625-0.625) — both sit inside the noise band, so they read 0% here by design and
// are left to the neural and geometric tiers rather than being faked up.
export const remapPhash = (sim) => remapTri(sim, 0.78, 0.82, 0.98);
// ORB raw is the RANSAC inlier ratio. Measured directly against example/ (11200 pairs,
// 1680 ORB-verified): coincidental texture matches between unrelated images never
// exceeded 0.0135, while real matches start as low as 0.037 — a >2x clean gap with zero
// observed overlap, nothing like the floor of 0.15 originally guessed. That floor was
// silently throwing away genuine signal: rotated/zoomed duplicates routinely score
// 0.04-0.3 raw (real geometric overlap, just less of it), which used to map to a flat
// 0%. Anchored just above the measured negative ceiling instead, with margin for photos
// this exact set didn't cover.
export const remapOrb = (orb) => remapTri(orb, 0.013, 0.03, 1.0);

// SSCD copy-detection cosine. Unlike the DINOv2 embedding this is trained to separate
// "copy of this image" from "different photo of the same subject", and it shows: measured
// over example/ (11200 pairs, 240 true dupes) the two classes don't overlap at all —
// worst non-duplicate 0.3369 vs hardest true duplicate 0.4379, where DINOv2's worst
// non-duplicate (0.9379) sits *above* its hardest duplicate (0.7093).
// Anchors: floor just above the measured non-duplicate ceiling so unrelated images read a
// true 0%, boundary in the middle of the empty gap, ceiling where duplicates are
// unambiguous (their median is 0.945).
// Upstream suggests 0.75 for 90% precision, but that's measured on DISC with ~1M
// distractors; a personal library sits between that and what example/ shows, so this
// leans to the recall side of the gap deliberately.
// The floor deliberately sits BELOW the measured worst non-duplicate (0.337) rather than
// above it. `lo` doubles as the candidate floor — a pair scoring under ~0.12 confidence is
// never built, so no tier can rescue it — and example/ is known to be easier than a real
// library. Buying a wider margin there costs only that unrelated images read ~36% instead
// of 0%, which is still nowhere near the 50% boundary.
export const remapSscd = (cos) => remapTri(cos, 0.20, 0.39, 0.95);

/* ---------- candidate pairs + clustering ---------- */

// Which pairs the candidate builder is allowed to produce. Shared with clusterPairs so
// cohesion checks and group averages never penalize a pair that was never eligible to be
// scored in the first place (in reference mode, Search x Search pairs are never built).
export function pairEligible(items) {
  const refMode = items.some(it => it.ref);
  return (a, b) => refMode
    ? ((a.ref && b.search) || (a.search && b.ref))
    : (a.search && b.search);
}

// Sparse pairwise signals, keeping only candidates above a low floor — *if* one of the
// per-image descriptor tiers actually ran. With all of them disabled (Geometric running
// solo), there's no cheap signal to filter on, so every valid pair has to go through as a
// candidate instead of silently producing zero — Geometric is then the only thing deciding
// what's a match.
// Role-aware: when any image is a reference (item.ref), only Reference×Search pairs are
// built (each reference vs each search image) — Ref×Ref and Search×Search are skipped, so
// a small reference set against a huge search set costs R*S comparisons instead of N²/2.
// With no reference present it falls back to all-pairs among the search images (legacy).
export function buildCandidatePairs(items, settings = {}) {
  const { usePhash = true, useNN = true, useCopy = true } = settings;
  // SSCD counts as a cheap signal: like the embedding it's one precomputed vector per
  // image, so scoring a pair is just a dot product. It's also the most reliable of the
  // three, so a pair it likes must be able to survive the candidate floor on its own.
  const cheapSignal = usePhash || useNN || useCopy;
  const n = items.length, pairs = [];
  const include = pairEligible(items);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!include(items[i], items[j])) continue;
      let sEmbed = 0, sPhash = 0, sSscd = 0;
      if (items[i].embedding && items[j].embedding) sEmbed = remapEmbed(cosine(items[i].embedding, items[j].embedding));
      if (items[i].sscd && items[j].sscd) sSscd = remapSscd(cosine(items[i].sscd, items[j].sscd));
      // Featureless images are skipped rather than allowed to match each other on noise.
      if (phashUsable(items[i].phash) && phashUsable(items[j].phash)) sPhash = remapPhash(phashSim(items[i].phash, items[j].phash));
      if (!cheapSignal || Math.max(sEmbed, sPhash, sSscd) >= 0.12) pairs.push({ i, j, sEmbed, sPhash, sSscd, sOrb: null });
    }
  }
  return pairs;
}

// The tier registry: [name, enable-setting, threshold-setting]. Everything that walks the
// tiers derives from this, so adding one can't silently miss a code path.
const TIERS = [
  ['phash', 'usePhash', 'tPhash'],
  ['nn', 'useNN', 'tNN'],
  ['geo', 'useGeo', 'tGeo'],
  ['copy', 'useCopy', 'tCopy']
];
const sigOf = {
  phash: (p) => p.sPhash,
  nn: (p) => p.sEmbed,
  geo: (p) => (p.sOrb == null ? 0 : p.sOrb),
  copy: (p) => (p.sSscd == null ? 0 : p.sSscd)
};
// Tiers whose signal is absent (not merely zero) for a given pair — geometric verification
// may not have run, and SSCD may not have been computed — must not be read as "0%".
const tierMissing = (tier, p) => (tier === 'geo' && p.sOrb == null) || (tier === 'copy' && p.sSscd == null);

// Each enabled tier has its OWN threshold (s.tPhash / s.tNN / s.tGeo / s.tCopy, all 0..1).
// A pair links a set if ANY enabled tier clears its threshold — the tiers have genuinely
// complementary blind spots (pHash can't see crops, the neural tier conflates same-subject
// with same-image), so requiring agreement would drop exactly the duplicates that only one
// tier can find.
export function pairLinks(p, s) {
  for (const [tier, useKey, tKey] of TIERS) {
    if (!s[useKey] || tierMissing(tier, p)) continue;
    if (sigOf[tier](p) >= s[tKey]) return true;
  }
  return false;
}

// Strongest signal among enabled tiers, for display.
export function pairBest(p, s) {
  let v = 0;
  for (const [tier, useKey] of TIERS) {
    if (!s[useKey] || tierMissing(tier, p)) continue;
    v = Math.max(v, sigOf[tier](p));
  }
  return v;
}

// How alike every pair inside a group must be, as a fraction of the tier thresholds.
// 0.5 = "at least half as similar as it takes to link". 0 disables the check entirely
// (restoring the old chain-prone single-linkage behavior).
export const DEFAULT_COHESION = 0.5;

// Normalized link strength: how far a pair is past the threshold of its strongest enabled
// tier, where >= 1 means it clears that tier (i.e. pairLinks is true). Expressing it as a
// ratio keeps tiers comparable even though each has its own threshold, so one cohesion
// number can govern all three at once.
export function pairStrength(p, s) {
  let v = 0;
  for (const [tier, useKey, tKey] of TIERS) {
    if (!s[useKey]) continue;
    if (tierMissing(tier, p)) continue;
    const t = s[tKey];
    // A missing/NaN threshold means this tier isn't configured — skip it. Letting it fall
    // through to the zero-threshold branch would return Infinity and silently make every
    // cohesion check pass, disabling the chaining guard app-wide.
    if (!Number.isFinite(t)) continue;
    if (t <= 0) return Infinity; // a zero threshold links everything by definition
    v = Math.max(v, sigOf[tier](p) / t);
  }
  return v;
}

// excluded: Set of pairKey(hashA,hashB) the user has explicitly marked as not-duplicates.
// Two images carrying such a relationship must never end up in the same group, even via
// a transitive third image. Links are merged strongest-first, so when image C matches
// both A and B (and A!=B), whichever of A/B is the *closer* match to its group wins —
// the weaker link is skipped rather than forcing a conflicting three-way merge.
export function clusterPairs(items, pairs, s, excluded = new Set()) {
  const n = items.length;
  const maxGroupSize = s.maxGroupSize || 10;
  const cohesion = s.cohesion == null ? DEFAULT_COHESION : s.cohesion;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };

  const eligible = pairEligible(items);
  // Candidate pairs are sparse, so index them for O(1) lookup of any two members.
  const pairAt = new Map();
  const keyAt = (i, j) => i < j ? i * n + j : j * n + i;
  for (const p of pairs) pairAt.set(keyAt(p.i, p.j), p);
  // An unscored pair fell below the candidate floor, i.e. no meaningful similarity.
  const strengthAt = (i, j) => { const p = pairAt.get(keyAt(i, j)); return p ? pairStrength(p, s) : 0; };

  const hashesOf = new Map();
  const membersOf = new Map();
  const size = new Array(n).fill(1);
  for (let i = 0; i < n; i++) { hashesOf.set(i, new Set([items[i].hash])); membersOf.set(i, [i]); }

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

  // Complete-linkage guard: EVERY eligible pair spanning the two clusters must clear the
  // cohesion floor, not just the one link that triggered the merge. Plain union-find is
  // transitive, so without this A-B and B-C drag A and C into one set even when A and C
  // are nothing alike — the single biggest source of junk sets.
  const cohesive = (rootA, rootB) => {
    for (const i of membersOf.get(rootA)) {
      for (const j of membersOf.get(rootB)) {
        if (!eligible(items[i], items[j])) continue;
        if (strengthAt(i, j) < cohesion) return false;
      }
    }
    return true;
  };

  const union = (a, b) => {
    a = find(a); b = find(b);
    if (a === b) return true;
    if (size[a] + size[b] > maxGroupSize) return false;
    if (refsOf.get(a).size + refsOf.get(b).size > 1) return false;
    if (excluded.size && conflicts(a, b)) return false;
    if (cohesion > 0 && !cohesive(a, b)) return false;
    parent[a] = b;
    size[b] += size[a];
    membersOf.set(b, [...membersOf.get(a), ...membersOf.get(b)]);
    membersOf.delete(a);
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

  const buckets = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!buckets.has(r)) buckets.set(r, []); buckets.get(r).push(i); }

  const groups = [];
  let gid = 0;
  for (const [, members] of buckets) {
    if (members.length < 2) continue;
    // Average each tier across EVERY eligible pair in the group (an unscored pair counts
    // as 0), so the reported confidence says how alike all the members are rather than
    // how strong the single best pair happened to be. `contributed` still tracks whether
    // a tier cleared its threshold somewhere, i.e. whether it helped form the group.
    // Derived from TIERS rather than hardcoded, so adding a tier can't leave its
    // accumulator undefined (which silently turns the whole average into NaN).
    const sum = {}, contributed = {};
    for (const [tier] of TIERS) { sum[tier] = 0; contributed[tier] = false; }
    let count = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const i = members[a], j = members[b];
        if (!eligible(items[i], items[j])) continue;
        count++;
        const p = pairAt.get(keyAt(i, j));
        for (const [tier, useKey, tKey] of TIERS) {
          if (!s[useKey]) continue;
          const v = p ? sigOf[tier](p) : 0;
          sum[tier] += v;
          if (p && v >= s[tKey] && !tierMissing(tier, p)) contributed[tier] = true;
        }
      }
    }
    const signals = [];
    for (const [tier, useKey] of TIERS) {
      if (s[useKey]) signals.push({ tier, score: count ? sum[tier] / count : 0, contributed: contributed[tier] });
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

/* ---------- persistent cache (SQLite via kempo-app) ----------
   Tables are declared in schema/dupcache/*.js and created/migrated automatically by
   kempo-app before the window ever opens — nothing here needs to check or create them.
   Every write goes through bound params (sqlQ's second argument / sqlTx's per-statement
   params), never string-built SQL: `hash` values are just SHA-256 hex, safe on their own,
   but `path` is a real filesystem path and can contain anything (quotes included). */

const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };

export function embToB64(arr) { const u8 = new Uint8Array(Float32Array.from(arr).buffer); let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
export function b64ToEmb(b64) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return Array.from(new Float32Array(u8.buffer)); }

// table/cols/keyCol are always fixed identifiers the caller passes in code (e.g. 'images',
// 'hash'), never user data — safe to interpolate, and not something a param placeholder
// could stand in for anyway (those only bind values, not column/table names).
export async function selectIn(table, cols, keyCol, keys) {
  const map = new Map();
  for (const part of chunk([...new Set(keys)], 300)) {
    if (!part.length) continue;
    const marks = part.map(() => '?').join(',');
    const rows = await sqlQ(`SELECT ${cols} FROM ${table} WHERE ${keyCol} IN (${marks})`, part);
    for (const r of rows) map.set(r[keyCol], r);
  }
  return map;
}

// Full set of confirmed not-duplicate pair keys. Needed (not just a lookup by candidate
// pair) because clusterPairs must catch *transitive* conflicts — e.g. A!=B is never a
// candidate pair itself if A and B aren't directly similar, only reachable via a third
// image C that matches both.
export async function getExcludedPairs() {
  const rows = await sqlQ('SELECT pair FROM excluded_pairs');
  return new Set(rows.map(r => r.pair));
}

// Each chunk is sent as one sqlTransaction batch — atomic (a crash partway through a chunk
// can't leave half its rows written) and, since every row reuses the exact same SQL text,
// no less efficient than the old hand-built multi-row VALUES(...) list.
export async function bulkUpsert(table, cols, rows) {
  const placeholders = `(${cols.map(() => '?').join(',')})`;
  const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES ${placeholders}`;
  for (const part of chunk(rows, 200)) {
    if (!part.length) continue;
    await sqlTx(part.map(r => ({ sql, params: cols.map(c => r[c] ?? null) })));
  }
}

export async function clearCache() {
  await sqlTx([
    { sql: 'DELETE FROM images', params: [] },
    { sql: 'DELETE FROM paths', params: [] },
    { sql: 'DELETE FROM orbcache', params: [] },
    { sql: 'DELETE FROM excluded_pairs', params: [] }
  ]);
}

/**
 * Drop a deleted file from the cache. Always removes its path row; removes the
 * content-hash features + its orb comparisons only when nothing else uses that hash.
 * All statements run as one transaction — path removal and hash cleanup are describing a
 * single event (this file is gone), not two independent ones.
 */
export async function removeFromCache(path, hash, deleteHash) {
  const statements = [{ sql: 'DELETE FROM paths WHERE path = ?', params: [path] }];
  if (deleteHash && hash) {
    statements.push(
      { sql: 'DELETE FROM images WHERE hash = ?', params: [hash] },
      { sql: 'DELETE FROM orbcache WHERE pair LIKE ? OR pair LIKE ?', params: [hash + '|%', '%|' + hash] },
      { sql: 'DELETE FROM excluded_pairs WHERE pair LIKE ? OR pair LIKE ?', params: [hash + '|%', '%|' + hash] }
    );
  }
  await sqlTx(statements);
}

/**
 * Carry "not duplicates" decisions across an edit.
 *
 * Identity is the SHA-256 of the file's bytes, so editing an image *outside* this app —
 * even just rewriting an EXIF tag — gives it a brand new hash. Every exclusion the user
 * recorded pointed at the old one, so without this the set they'd already dismissed comes
 * straight back and has to be dismissed again.
 *
 * Copies rather than moves: the old hash may still belong to another file (a second copy
 * that wasn't edited), whose exclusions must stay intact. Any rows left genuinely
 * unreferenced are cleaned up by gcCache().
 *
 * excluded_pairs is the only table worth migrating — features and ORB scores are just
 * recomputable derivations of bytes that no longer exist, but this one holds a human
 * judgement that can't be recovered.
 */
export async function migrateExcludedPairs(oldHash, newHash) {
  if (!oldHash || !newHash || oldHash === newHash) return 0;
  const rows = await sqlQ('SELECT pair FROM excluded_pairs WHERE pair LIKE ? OR pair LIKE ?', [oldHash + '|%', '%|' + oldHash]);
  const add = [];
  for (const r of rows) {
    const [a, b] = String(r.pair).split('|');
    const other = a === oldHash ? b : a;
    // If the other side of the pair is already the new hash, remapping would produce a
    // self-pair — meaningless, and it would make an image "not a duplicate of itself".
    if (!other || other === newHash) continue;
    add.push({ pair: pairKey(newHash, other) });
  }
  if (add.length) await bulkUpsert('excluded_pairs', ['pair'], add);
  return add.length;
}

/**
 * Drop cached rows for content hashes nothing points at anymore — what an external edit
 * leaves behind, since the path keeps its name but changes identity. Without this the
 * cache only ever grows.
 *
 * Keyed off the `paths` table rather than the current scan: `paths` accumulates every file
 * ever seen, so folders that weren't part of this scan still count as referenced and their
 * work is never thrown away.
 *
 * Deliberately does NOT touch excluded_pairs. A hash can be temporarily unreferenced —
 * an unplugged drive, a folder removed from the sources — and deleting the user's
 * decisions over that would be unrecoverable. Stale rows there are harmless: they can only
 * ever match a hash that no longer exists.
 */
export async function gcCache() {
  const live = 'SELECT hash FROM paths WHERE hash IS NOT NULL';
  const before = await sqlQ('SELECT (SELECT COUNT(*) FROM images) AS i, (SELECT COUNT(*) FROM orbcache) AS o');
  // The two deletes describe one cleanup pass — atomic so a crash between them can't leave
  // images and orbcache disagreeing about which hashes are still live.
  await sqlTx([
    { sql: `DELETE FROM images WHERE hash NOT IN (${live})`, params: [] },
    // orbcache keys are "hashA|hashB"; a row is dead if either side is gone.
    { sql: `DELETE FROM orbcache WHERE substr(pair, 1, instr(pair, '|') - 1) NOT IN (${live}) OR substr(pair, instr(pair, '|') + 1) NOT IN (${live})`, params: [] }
  ]);
  const after = await sqlQ('SELECT (SELECT COUNT(*) FROM images) AS i, (SELECT COUNT(*) FROM orbcache) AS o');
  return {
    images: (before?.[0]?.i || 0) - (after?.[0]?.i || 0),
    orb: (before?.[0]?.o || 0) - (after?.[0]?.o || 0)
  };
}

// Mark every pairwise combination among these content hashes as confirmed-not-duplicates,
// so future scans never link or geometrically compare them again.
export async function markNotDuplicates(hashes) {
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
