/**
 * Calibration harness for the three detection tiers.
 *
 * Scores every (reference x search) pair in example/ against known ground truth, so the
 * remap functions in lib/engine.js can be fit to measured data instead of guessed. The
 * example set is built for exactly this: each search image named `<ref>-<variant>.jpg`
 * is a true duplicate of `example/ref/<ref>.jpg`, and the remaining search images are
 * adversarial distractors (same category, different subject) that must NOT match anything.
 *
 * Raw (pre-remap) scores are cached in tools/.cache so re-running the analysis after
 * changing a remap is instant — delete that folder to force a recompute.
 *
 * Usage:
 *   node tools/calibrate.js               # full run (features + pairs + analysis)
 *   node tools/calibrate.js --no-orb      # skip the slow geometric tier
 *   node tools/calibrate.js --analyze     # re-analyze cached scores only
 *   node tools/calibrate.js --orb-sample 600
 *       Score the geometric tier on every true-duplicate pair plus ~600 evenly-sampled
 *       non-duplicates instead of all N*M. Exhaustive ORB is minutes-to-hours; this
 *       answers "what does this tier catch, and where does its boundary belong" in a
 *       fraction of that. The sample is deterministic (every k-th pair) so runs stay
 *       comparable, and uniform so the false-positive RATE is unbiased — only its
 *       resolution drops, since it's measured over the sample rather than every pair.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { phash, initModel, embed } from '../src/engine.js';

sharp.cache(false);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EX = path.join(ROOT, 'example');
const CACHE = path.join(ROOT, 'tools', '.cache');

const args = process.argv.slice(2);
const NO_ORB = args.includes('--no-orb');
const ANALYZE_ONLY = args.includes('--analyze');
const ORB_SAMPLE = args.includes('--orb-sample') ? Number(args[args.indexOf('--orb-sample') + 1]) || 600 : 0;
const NO_SSCD = args.includes('--no-sscd');

/* ---------- ground truth ---------- */

// A search image is a duplicate of a reference when its name is that reference's name
// plus a `-<variant>` suffix (`audi-r8-zoomed` <- `audi-r8`). Derived by longest-prefix
// match against the actual reference names rather than a fixed list of variants, so
// dropping new variant types into example/search needs no code change here — whatever
// suffix you invent is picked up and reported in the variant inventory below.
// Longest match wins so a reference like `mazda-rx7-2` isn't read as variant "2" of a
// hypothetical `mazda-rx7`.
const baseOf = (file) => path.basename(file, path.extname(file));

/**
 * HARD NEGATIVES — the failure mode that matters most in a real library.
 *
 * Files in example/search named `nondupe-<subject>-<whatever>.jpg` declare "same subject,
 * DIFFERENT photo". Any two sharing a <subject> must never be grouped: the same person in
 * a different outfit/location, two shots from one burst, two photos of the same car.
 *
 * This is the class the neural tier gets wrong, because DINOv2 is a general-purpose
 * semantic model — rating "same person, same pose" as highly similar is what it was
 * trained to do. The ref/variant pairs elsewhere in example/ can't measure this at all,
 * so without hard negatives the false-positive rate reads far better than reality.
 *
 * e.g.  nondupe-alice-beach.jpg  nondupe-alice-office.jpg  nondupe-alice-hiking.jpg
 */
const HARD_NEG = /^nondupe-([^-]+)-/;
const hardNegSubject = (file) => { const m = baseOf(file).match(HARD_NEG); return m ? m[1] : null; };

function makeTruth(refs) {
  const refBases = refs.map(baseOf).sort((a, b) => b.length - a.length);
  return (searchFile) => {
    const b = baseOf(searchFile);
    for (const r of refBases) {
      if (b === r) return { source: r, variant: 'identical' };
      if (b.startsWith(r + '-')) return { source: r, variant: b.slice(r.length + 1) };
    }
    return { source: null, variant: 'distractor' };
  };
}

/* ---------- cache ---------- */

const readCache = async (name) => {
  try { return JSON.parse(await fs.readFile(path.join(CACHE, name), 'utf8')); }
  catch { return null; }
};
const writeCache = async (name, data) => {
  await fs.mkdir(CACHE, { recursive: true });
  await fs.writeFile(path.join(CACHE, name), JSON.stringify(data));
};

/* ---------- tier math (mirrors lib/engine.js, pre-remap) ---------- */

const POP = {};
for (let i = 0; i < 16; i++) { let c = 0, n = i; while (n) { c += n & 1; n >>= 1; } POP[i.toString(16)] = c; }
const hamHex = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += POP[(parseInt(a[i], 16) ^ parseInt(b[i], 16)).toString(16)]; return d; };
// Accepts either the legacy string[8] or the current { hashes, detail } payload.
const hashesOf = (v) => Array.isArray(v) ? v : (v && v.hashes) || null;
const detailOf = (v) => Array.isArray(v) ? null : (v && v.detail != null ? v.detail : null);
// A[0] (identity) vs all 8 dihedral orientations of B — the dihedral group is closed,
// so this covers every relative orientation without needing 8x8 comparisons.
const phashSim = (A, B) => {
  const a = hashesOf(A), b = hashesOf(B);
  if (!a || !b) return 0;
  let best = 64; for (const h of b) best = Math.min(best, hamHex(a[0], h)); return 1 - best / 64;
};
const cosine = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/* ---------- feature extraction ---------- */

async function listImages() {
  const refs = (await fs.readdir(path.join(EX, 'ref'))).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  const search = (await fs.readdir(path.join(EX, 'search'))).filter(f => /\.(jpe?g|png|webp)$/i.test(f));
  return { refs, search };
}

// Incremental: only images missing from the cache are (re)computed, so adding new
// examples costs just those images rather than the whole set.
async function buildFeatures(refs, search) {
  const feats = (await readCache('features.json')) || {};
  const all = [...refs.map(f => ['ref', f]), ...search.map(f => ['search', f])];

  // Legacy array-shaped pHash rows carry no `detail`, so recompute those — it's cheap
  // (resize + DCT) next to the embedding, which is left cached.
  const needPhash = all.filter(([d, f]) => detailOf(feats[`${d}/${f}`]?.phash) == null);
  const needEmbed = all.filter(([d, f]) => !feats[`${d}/${f}`]?.embedding);
  const needSscd = NO_SSCD ? [] : all.filter(([d, f]) => !feats[`${d}/${f}`]?.sscd);
  const reused = all.length - Math.max(needPhash.length, needEmbed.length);
  if (reused) console.log(`features: reusing ${reused} cached image(s)`);

  if (needPhash.length) {
    console.log(`features: computing pHash for ${needPhash.length} image(s)…`);
    for (let i = 0; i < needPhash.length; i++) {
      const [dir, f] = needPhash[i];
      const k = `${dir}/${f}`;
      feats[k] = { ...(feats[k] || {}), phash: await phash(path.join(EX, dir, f)) };
      if ((i + 1) % 40 === 0) console.log(`  pHash ${i + 1}/${needPhash.length}`);
    }
  }

  if (needEmbed.length) {
    console.log('features: loading DINOv2 (first run downloads it)…');
    const { device } = await initModel(['cpu']);
    console.log(`features: embedding ${needEmbed.length} image(s) on ${device}…`);
    for (let i = 0; i < needEmbed.length; i++) {
      const [dir, f] = needEmbed[i];
      const k = `${dir}/${f}`;
      feats[k] = { ...(feats[k] || {}), embedding: await embed(path.join(EX, dir, f)) };
      if ((i + 1) % 20 === 0) console.log(`  embed ${i + 1}/${needEmbed.length}`);
    }
  }

  if (needSscd.length) {
    const { default: initSscd } = await import('../api/initSscd.js');
    const info = await initSscd();
    if (!info.ok) {
      console.log(`features: SSCD tier SKIPPED — ${info.error}`);
    } else {
      const { embedSscd } = await import('../src/sscd.js');
      console.log(`features: SSCD descriptors for ${needSscd.length} image(s)…`);
      for (let i = 0; i < needSscd.length; i++) {
        const [dir, f] = needSscd[i];
        const k = `${dir}/${f}`;
        feats[k] = { ...(feats[k] || {}), sscd: await embedSscd(path.join(EX, dir, f)) };
        if ((i + 1) % 80 === 0) console.log(`  sscd ${i + 1}/${needSscd.length}`);
      }
    }
  }

  if (needPhash.length || needEmbed.length || needSscd.length) await writeCache('features.json', feats);
  return feats;
}

/* ---------- ORB (same parameters as the renderer worker in lib/engine.js) ---------- */

async function loadCv() {
  const m = await import('@techstark/opencv-js');
  const cv = m.default || m;
  if (cv && cv.Mat) return cv;
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('opencv init timeout')), 60000);
    cv.onRuntimeInitialized = () => { clearTimeout(t); res(); };
  });
  return cv;
}

// Matches api/grayBuffer.js: EXIF-rotated, greyscale, longest edge 512.
async function grayOf(p) {
  const { data, info } = await sharp(await fs.readFile(p), { failOn: 'none' })
    .rotate().greyscale().resize(512, 512, { fit: 'inside' })
    .raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

function orbBuild(cv, g) {
  const mat = cv.matFromArray(g.height, g.width, cv.CV_8UC1, Array.from(g.data));
  const orb = new cv.ORB(800), kp = new cv.KeyPointVector(), des = new cv.Mat(), nm = new cv.Mat();
  orb.detectAndCompute(mat, nm, kp, des);
  const n = kp.size(), kpx = new Float32Array(n), kpy = new Float32Array(n);
  for (let i = 0; i < n; i++) { const pt = kp.get(i).pt; kpx[i] = pt.x; kpy[i] = pt.y; }
  mat.delete(); orb.delete(); kp.delete(); nm.delete();
  return { des, kpx, kpy, count: n };
}

function orbMatch(cv, A, B) {
  if (!A || !B || A.count < 8 || B.count < 8) return 0;
  const bf = new cv.BFMatcher(cv.NORM_HAMMING, false), knn = new cv.DMatchVectorVector();
  bf.knnMatch(A.des, B.des, knn, 2);
  const gi = [], gj = [];
  for (let i = 0; i < knn.size(); i++) {
    const m = knn.get(i); if (m.size() < 2) continue;
    const a = m.get(0), b = m.get(1);
    if (a.distance < 0.75 * b.distance) { gi.push(a.queryIdx); gj.push(a.trainIdx); }
  }
  knn.delete(); bf.delete();
  const denom = Math.min(A.count, B.count);
  if (gi.length < 8) return gi.length / Math.max(denom, 8);
  const src = [], dst = [];
  for (let k = 0; k < gi.length; k++) { src.push(A.kpx[gi[k]], A.kpy[gi[k]]); dst.push(B.kpx[gj[k]], B.kpy[gj[k]]); }
  const sm = cv.matFromArray(gi.length, 1, cv.CV_32FC2, src), dm = cv.matFromArray(gi.length, 1, cv.CV_32FC2, dst), mask = new cv.Mat();
  const H = cv.findHomography(sm, dm, cv.RANSAC, 5, mask);
  let inl = 0; for (let i = 0; i < mask.rows; i++) inl += mask.data[i];
  sm.delete(); dm.delete(); mask.delete(); try { H.delete(); } catch {}
  return Math.max(0, Math.min(1, inl / denom));
}

/* ---------- pair scoring ---------- */

// Incremental, keyed by `ref|search`: adding examples only scores the new combinations
// instead of re-running the (slow) geometric tier over every pair again.
async function buildPairs(refs, search, feats, truth) {
  const cached = await readCache('pairs.json');
  const by = {};
  // Tolerate the earlier array-shaped cache so an in-flight run's work isn't wasted.
  if (Array.isArray(cached?.rows)) for (const r of cached.rows) by[`${r.ref}|${r.search}`] = r;
  else if (cached?.by) Object.assign(by, cached.by);

  const want = [];
  for (const r of refs) for (const s of search) want.push([r, s]);

  const needCheap = want.filter(([r, s]) => by[`${r}|${s}`] === undefined);
  if (want.length - needCheap.length) console.log(`pairs: reusing ${want.length - needCheap.length} cached pair(s)`);
  if (needCheap.length) {
    console.log(`pairs: scoring ${needCheap.length} new pair(s) (pHash + neural)…`);
    for (const [r, s] of needCheap) {
      const fr = feats[`ref/${r}`], fs_ = feats[`search/${s}`];
      by[`${r}|${s}`] = {
        ref: r, search: s,
        rawPhash: phashSim(fr.phash, fs_.phash),
        rawEmbed: cosine(fr.embedding, fs_.embedding),
        rawSscd: fr.sscd && fs_.sscd ? cosine(fr.sscd, fs_.sscd) : null,
        rawOrb: null
      };
    }
  }

  let needOrb = NO_ORB ? [] : want.map(([r, s]) => by[`${r}|${s}`]).filter(row => row.rawOrb == null);
  if (ORB_SAMPLE && needOrb.length) {
    // Keep every true duplicate (they're the scarce, informative class) and take an even
    // stride through the non-duplicates. Uniform sampling keeps the measured FPR unbiased.
    const isDupe = (row) => truth(row.search).source === baseOf(row.ref);
    const pos = needOrb.filter(isDupe), negAll = needOrb.filter(r => !isDupe(r));
    const stride = Math.max(1, Math.floor(negAll.length / ORB_SAMPLE));
    const negS = negAll.filter((_, i) => i % stride === 0).slice(0, ORB_SAMPLE);
    console.log(`pairs: --orb-sample ${ORB_SAMPLE} -> geometric tier on ${pos.length} true dupes + ${negS.length} sampled non-dupes (of ${negAll.length})`);
    needOrb = [...pos, ...negS];
  }
  if (needOrb.length) {
    const cv = await loadCv();
    // Only images actually involved in an outstanding pair need descriptors built.
    const involved = new Set();
    for (const row of needOrb) { involved.add(`ref/${row.ref}`); involved.add(`search/${row.search}`); }
    console.log(`pairs: building ORB descriptors for ${involved.size} image(s)…`);
    const desc = {};
    let n = 0;
    for (const key of involved) {
      const [dir, ...rest] = key.split('/');
      desc[key] = orbBuild(cv, await grayOf(path.join(EX, dir, rest.join('/'))));
      if (++n % 40 === 0) console.log(`  orb-desc ${n}/${involved.size}`);
    }
    console.log(`pairs: geometric matching ${needOrb.length} pair(s)…`);
    for (let i = 0; i < needOrb.length; i++) {
      const row = needOrb[i];
      try { row.rawOrb = orbMatch(cv, desc[`ref/${row.ref}`], desc[`search/${row.search}`]); }
      catch { row.rawOrb = null; }
      // Checkpoint periodically: this loop can run for tens of minutes, and losing all of
      // it to an interrupt (or resuming from scratch) would make the tool unusable as the
      // example set grows. Resuming just re-scores whatever is still missing.
      if ((i + 1) % 500 === 0) {
        console.log(`  orb ${i + 1}/${needOrb.length}`);
        await writeCache('pairs.json', { hasOrb: true, by });
      }
    }
    for (const k in desc) { try { desc[k].des.delete(); } catch {} }
  }

  const hasOrb = want.some(([r, s]) => by[`${r}|${s}`].rawOrb != null);
  if (needCheap.length || needOrb.length) await writeCache('pairs.json', { hasOrb, by });
  return { hasOrb, rows: want.map(([r, s]) => by[`${r}|${s}`]) };
}

/* ---------- analysis ---------- */

const pct = (x) => (100 * x).toFixed(1) + '%';
const f4 = (x) => x == null ? '  n/a ' : x.toFixed(4);

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

// Best single split point between positives and negatives, by Youden's J
// (sensitivity + specificity - 1). This is the raw value that best separates
// "duplicate" from "not duplicate" — i.e. what `mid` in remapTri should be.
function bestSplit(pos, neg) {
  const cand = [...new Set([...pos, ...neg])].sort((a, b) => a - b);
  let best = { t: null, j: -1, tpr: 0, fpr: 1 };
  for (let i = 0; i < cand.length; i++) {
    const t = i + 1 < cand.length ? (cand[i] + cand[i + 1]) / 2 : cand[i];
    const tpr = pos.filter(v => v >= t).length / (pos.length || 1);
    const fpr = neg.filter(v => v >= t).length / (neg.length || 1);
    const j = tpr - fpr;
    if (j > best.j) best = { t, j, tpr, fpr };
  }
  return best;
}

function analyzeTier(name, rows, get) {
  const vals = rows.map(r => ({ v: get(r), dupe: r.dupe, variant: r.variant })).filter(r => r.v != null);
  const pos = vals.filter(r => r.dupe).map(r => r.v).sort((a, b) => a - b);
  const neg = vals.filter(r => !r.dupe).map(r => r.v).sort((a, b) => a - b);
  if (!pos.length || !neg.length) { console.log(`\n${name}: no data`); return null; }

  const split = bestSplit(pos, neg);
  const negMax = neg[neg.length - 1], posMin = pos[0];

  console.log(`\n== ${name} ==  (${pos.length} true dupes, ${neg.length} non-dupes)`);
  console.log(`  duplicates    min ${f4(posMin)}  p05 ${f4(quantile(pos, .05))}  median ${f4(quantile(pos, .5))}  max ${f4(pos[pos.length - 1])}`);
  console.log(`  non-duplicates min ${f4(neg[0])}  median ${f4(quantile(neg, .5))}  p95 ${f4(quantile(neg, .95))}  p99 ${f4(quantile(neg, .99))}  max ${f4(negMax)}`);
  console.log(`  best split ${f4(split.t)}  ->  catches ${pct(split.tpr)} of dupes, ${pct(split.fpr)} false-positive rate`);
  console.log(`  overlap: ${negMax > posMin ? `YES (worst non-dupe ${f4(negMax)} > best-case dupe ${f4(posMin)})` : 'none — cleanly separable'}`);

  // Per-variant recall at the best split, so we can see which duplicate types a tier misses.
  const byVariant = {};
  for (const r of vals) {
    if (!r.dupe) continue;
    (byVariant[r.variant] ||= []).push(r.v);
  }
  const rec = Object.entries(byVariant).map(([k, arr]) =>
    `${k} ${pct(arr.filter(v => v >= split.t).length / arr.length)}`).sort();
  console.log(`  recall by variant @ best split: ${rec.join('  ')}`);

  // Suggested remapTri anchors: mid = best split; lo just under the negatives' bulk so
  // ordinary non-dupes land at 0%; hi where dupes are confidently in. When the negatives'
  // tail runs past the split (heavily overlapping tiers), a p99-based lo would land above
  // mid and invert the ramp — back off to just below the split instead.
  const mid = split.t;
  const lo = Math.min(quantile(neg, .99), mid - 1e-4);
  const hi = Math.max(quantile(pos, .90), mid + 1e-4);
  console.log(`  suggested remapTri(lo=${f4(lo)}, mid=${f4(mid)}, hi=${f4(hi)})`);
  if (quantile(neg, .99) >= mid) console.log(`    (note: non-dupes overlap the split — this tier can't cleanly separate on its own)`);
  return { pos, neg, split, lo, hi };
}

/* ---------- hard negatives: same subject, different photo ---------- */

/**
 * Scores every within-subject pair among the `nondupe-<subject>-*` files. These SHOULD all
 * score low; anything clearing a tier's threshold is a false positive of the exact kind
 * that shows up on a real photo library ("same person, different location, flagged as a
 * duplicate"). Reported per tier so it's obvious which one is responsible.
 */
async function analyzeHardNegatives(search, feats) {
  if (!feats) return;
  const bySubject = {};
  for (const f of search) { const s = hardNegSubject(f); if (s) (bySubject[s] ||= []).push(f); }
  const subjects = Object.entries(bySubject).filter(([, files]) => files.length > 1);

  if (!subjects.length) {
    console.log('\n== hard negatives (same subject, different photo) ==');
    console.log('  NONE PRESENT — add files named nondupe-<subject>-<desc>.jpg to example/search/');
    console.log('  Without them the measured false-positive rate is optimistic: the ref/variant');
    console.log('  pairs here never test "same subject but genuinely a different photo".');
    return;
  }

  const pairs = [];
  for (const [subject, files] of subjects) {
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      const a = feats[`search/${files[i]}`], b = feats[`search/${files[j]}`];
      if (!a || !b) continue;
      pairs.push({
        subject, a: files[i], b: files[j],
        rawPhash: phashSim(a.phash, b.phash),
        rawEmbed: cosine(a.embedding, b.embedding),
        rawSscd: a.sscd && b.sscd ? cosine(a.sscd, b.sscd) : null
      });
    }
  }
  console.log(`\n== hard negatives (same subject, different photo) ==`);
  console.log(`  ${subjects.length} subject(s), ${pairs.length} within-subject pair(s) that must NOT group`);
  if (!pairs.length) return;

  // Judge with the app's real remaps so these numbers mean what the UI would show.
  const { remapPhash, remapEmbed } = await import('../lib/engine.js');
  const badP = pairs.filter(p => remapPhash(p.rawPhash) >= 0.5);
  const badE = pairs.filter(p => remapEmbed(p.rawEmbed) >= 0.5);
  const bad = pairs.filter(p => remapPhash(p.rawPhash) >= 0.5 || remapEmbed(p.rawEmbed) >= 0.5);
  console.log(`  falsely linked @50%:  pHash ${badP.length}/${pairs.length}   Neural ${badE.length}/${pairs.length}   either ${bad.length}/${pairs.length} (${pct(bad.length / pairs.length)})`);
  const es = pairs.map(p => p.rawEmbed).sort((a, b) => a - b);
  console.log(`  raw neural cosine: median ${f4(quantile(es, .5))}  p90 ${f4(quantile(es, .9))}  MAX ${f4(es[es.length - 1])}`);
  for (const p of [...bad].sort((x, y) => y.rawEmbed - x.rawEmbed).slice(0, 5)) {
    console.log(`    ${p.a} vs ${p.b}  neural ${f4(p.rawEmbed)} -> ${pct(remapEmbed(p.rawEmbed))}`);
  }
}

/* ---------- end-to-end group quality ---------- */

/**
 * Runs the real buildCandidatePairs + clusterPairs over the example set and reports
 * group-level quality. Pair-level AUC is not what a user sees — they see sets, and a set
 * is only good if everything in it belongs together. A set is "clean" when all its members
 * trace back to the same source image, and "contaminated" otherwise.
 */
async function analyzeGroups(refs, search, feats, orbBy, truth) {
  const { buildCandidatePairs, clusterPairs } = await import('../lib/engine.js');

  const items = [
    ...refs.map(f => ({ path: `ref/${f}`, hash: `ref/${f}`, ref: true, search: false, ...feats[`ref/${f}`] })),
    ...search.map(f => ({ path: `search/${f}`, hash: `search/${f}`, ref: false, search: true, ...feats[`search/${f}`] }))
  ];
  // The source image each item traces back to — a reference is its own source.
  const sourceOfItem = (it) => it.ref ? baseOf(it.path) : truth(path.basename(it.path)).source;

  const run = (settings, label) => {
    const pairs = buildCandidatePairs(items, settings);
    // Fill in the geometric tier from the cache, mirroring what a real scan does.
    // The ORB cache is keyed reference-first. Try both orders so this still resolves in
    // search-only mode, where the ref/search flags have been flattened away. Pairs with no
    // cached entry (search x search) simply have no geometric signal here.
    if (orbBy) {
      for (const p of pairs) {
        const a = path.basename(items[p.i].path), b = path.basename(items[p.j].path);
        const raw = (orbBy[`${a}|${b}`] || orbBy[`${b}|${a}`])?.rawOrb;
        if (raw != null) p.sOrb = remapOrbLocal(raw);
      }
    }
    const groups = clusterPairs(items, pairs, settings, new Set());

    let clean = 0, contaminated = 0, grouped = 0;
    const contaminants = [];
    for (const g of groups) {
      const srcs = g.members.map(m => sourceOfItem(items[m]));
      const distinct = [...new Set(srcs.filter(Boolean))];
      const hasNull = srcs.some(s => !s); // a distractor has no source at all
      if (distinct.length === 1 && !hasNull) { clean++; grouped += g.members.length; }
      else { contaminated++; if (contaminants.length < 4) contaminants.push(g.members.map(m => path.basename(items[m].path)).join(' + ')); }
    }
    // Recall: true duplicates that landed in the same set as their own source image.
    // Keyed off the source file's location rather than the ref flag, so this still works
    // in search-only mode where those flags have been flattened.
    const found = new Set();
    for (const g of groups) {
      const srcMember = g.members.find(m => items[m].path.startsWith('ref/'));
      if (srcMember == null) continue;
      const rb = baseOf(items[srcMember].path);
      for (const m of g.members) {
        const it = items[m];
        if (it.path.startsWith('search/') && truth(path.basename(it.path)).source === rb) found.add(it.path);
      }
    }
    const totalDupes = search.filter(s => truth(s).source).length;
    console.log(`  ${label.padEnd(30)} sets ${String(groups.length).padStart(3)}  clean ${String(clean).padStart(3)}  contaminated ${String(contaminated).padStart(3)}  dupes found ${found.size}/${totalDupes} (${pct(found.size / totalDupes)})`);
    if (contaminants.length) for (const c of contaminants) console.log(`      contaminated e.g.: ${c}`);
    return { groups, clean, contaminated, found: found.size };
  };

  const base = { usePhash: true, useNN: true, useGeo: !!orbBy, tPhash: 0.5, tNN: 0.5, tGeo: 0.5, maxGroupSize: 10 };
  console.log('\n== end-to-end set quality: REFERENCE mode (thresholds all 50%) ==');
  run({ ...base, cohesion: 0 }, 'cohesion OFF (old behavior)');
  run({ ...base, cohesion: 0.5 }, 'cohesion 50% (new default)');
  run({ ...base, cohesion: 0.75 }, 'cohesion 75%');

  // Reference mode can't produce chained sets: Ref x Ref pairs are never built, so a
  // group is always one reference plus its own matches. Scanning a plain photo folder
  // (no references) is the common case AND the one where union-find chaining bites, so
  // re-run with every image treated as a search image to actually exercise it.
  for (const it of items) { it.ref = false; it.search = true; }
  console.log('\n== end-to-end set quality: SEARCH-ONLY mode (no references) ==');
  run({ ...base, cohesion: 0 }, 'cohesion OFF (old behavior)');
  run({ ...base, cohesion: 0.5 }, 'cohesion 50% (new default)');
  run({ ...base, cohesion: 0.75 }, 'cohesion 75%');
}

// Local copy so group analysis doesn't depend on import order of the tuned remap.
const remapTriLocal = (raw, lo, mid, hi) => raw <= lo ? 0 : raw >= hi ? 1 : (raw < mid ? 0.5 * (raw - lo) / (mid - lo) : 0.5 + 0.5 * (raw - mid) / (hi - mid));
const remapOrbLocal = (orb) => remapTriLocal(orb, 0.013, 0.03, 1.0);

/* ---------- report ---------- */

async function main() {
  const { refs, search } = await listImages();
  const truth = makeTruth(refs);

  // Variant inventory — every suffix found in example/search, so newly-added duplicate
  // types show up here (and a typo'd name shows up as an unexpected 'distractor').
  const inventory = {};
  for (const s of search) { const { variant } = truth(s); inventory[variant] = (inventory[variant] || 0) + 1; }
  const nDupe = search.filter(s => truth(s).source).length;
  console.log(`example set: ${refs.length} refs, ${search.length} search (${nDupe} true dupes, ${search.length - nDupe} distractors)`);
  console.log('variants: ' + Object.entries(inventory).sort().map(([k, v]) => `${k}=${v}`).join('  '));

  let data;
  if (ANALYZE_ONLY) {
    const cached = await readCache('pairs.json');
    if (!cached) { console.error('no cached pairs — run without --analyze first'); process.exit(1); }
    const rows = Array.isArray(cached.rows) ? cached.rows : Object.values(cached.by || {});
    data = { hasOrb: cached.hasOrb, rows };
    console.log(`analyzing cached pairs (${rows.length}, orb=${data.hasOrb})`);
  } else {
    const feats = await buildFeatures(refs, search);
    data = await buildPairs(refs, search, feats, truth);
  }

  // Label against ground truth here (not in the cache) so relabelling is free.
  const rows = data.rows.map(r => {
    const t = truth(r.search);
    return { ...r, dupe: t.source === baseOf(r.ref), variant: t.variant };
  });
  const truePairs = rows.filter(r => r.dupe).length;
  console.log(`\npairs: ${rows.length} total, ${truePairs} true duplicate pairs, ${rows.length - truePairs} non-duplicate`);

  // pHash detail (contrast) distribution — informs PHASH_MIN_DETAIL. Add flat/dark/blank
  // images to example/ to calibrate this properly; a normal photo set won't exercise it.
  const feats = await readCache('features.json');
  if (feats) {
    const details = Object.entries(feats).map(([k, v]) => [k, detailOf(v.phash)]).filter(([, d]) => d != null);
    if (details.length) {
      const ds = details.map(([, d]) => d).sort((a, b) => a - b);
      console.log(`\npHash detail (contrast std, 0-255): min ${f4(ds[0])}  p05 ${f4(quantile(ds, .05))}  median ${f4(quantile(ds, .5))}  max ${f4(ds[ds.length - 1])}`);
      const low = details.filter(([, d]) => d < 6);
      console.log(`  below PHASH_MIN_DETAIL=6: ${low.length} image(s)${low.length ? ' -> ' + low.slice(0, 5).map(([k]) => k).join(', ') : ''}`);
    } else {
      console.log('\npHash detail: not present in cache (legacy features) — delete tools/.cache/features.json to recompute');
    }
  }

  await analyzeHardNegatives(search, await readCache('features.json'));

  analyzeTier('pHash (raw hamming similarity)', rows, r => r.rawPhash);
  analyzeTier('Neural / DINOv2 (raw cosine)', rows, r => r.rawEmbed);
  analyzeTier('SSCD copy detection (raw cosine)', rows, r => r.rawSscd);
  if (data.hasOrb) analyzeTier('ORB geometric (raw RANSAC inlier ratio)', rows, r => r.rawOrb);

  const featsForGroups = await readCache('features.json');
  if (featsForGroups) {
    const orbBy = {};
    if (data.hasOrb) for (const r of data.rows) if (r.rawOrb != null) orbBy[`${r.ref}|${r.search}`] = r;
    await analyzeGroups(refs, search, featsForGroups, data.hasOrb ? orbBy : null, truth);
  }

  await writeCache('rows.json', rows);
  console.log('\nraw per-pair scores written to tools/.cache/rows.json');
}

main().catch(e => { console.error(e); process.exit(1); });
