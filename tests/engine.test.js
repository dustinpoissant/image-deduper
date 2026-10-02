// Pure math/clustering logic from lib/engine.js — no DOM, no window.api — runs in both
// Node and the browser. The SQLite-cache helpers in the same file aren't covered here: the
// shared test mock's sqlQuery deliberately throws ("better-sqlite3 is not available in
// browser tests"), so there's no meaningful way to exercise them outside a real Electron run.
import {
  clamp01, fmtBytes, pairKey, hamHex, phashHashes, phashDetail, phashUsable,
  phashSim, cosine, remapEmbed, remapPhash, remapOrb, remapSscd,
  pairEligible, buildCandidatePairs, pairLinks, pairBest, pairStrength,
  clusterPairs, embToB64, b64ToEmb,
} from '../lib/engine.js';

export default {
  /* clamp01 / fmtBytes */
  'clamp01: clamps below 0 to 0': ({pass, fail}) => {
    if(clamp01(-5) === 0) pass(); else fail(`Expected 0, got ${clamp01(-5)}`);
  },
  'clamp01: clamps above 1 to 1': ({pass, fail}) => {
    if(clamp01(2) === 1) pass(); else fail(`Expected 1, got ${clamp01(2)}`);
  },
  'clamp01: passes through in-range values': ({pass, fail}) => {
    if(clamp01(0.5) === 0.5) pass(); else fail(`Expected 0.5, got ${clamp01(0.5)}`);
  },
  'fmtBytes: formats sub-MB sizes in KB': ({pass, fail}) => {
    if(fmtBytes(5000) === '5 KB') pass(); else fail(`Expected "5 KB", got "${fmtBytes(5000)}"`);
  },
  'fmtBytes: formats sizes over 1MB in MB with one decimal': ({pass, fail}) => {
    if(fmtBytes(2_500_000) === '2.5 MB') pass(); else fail(`Expected "2.5 MB", got "${fmtBytes(2_500_000)}"`);
  },

  /* pairKey */
  'pairKey: sorts hashes so order of arguments does not matter': ({pass, fail}) => {
    if(pairKey('a', 'b') === 'a|b' && pairKey('b', 'a') === 'a|b') pass();
    else fail(`Expected both orders to give "a|b", got "${pairKey('a','b')}" / "${pairKey('b','a')}"`);
  },

  /* hamHex */
  'hamHex: identical hex strings have distance 0': ({pass, fail}) => {
    if(hamHex('0000', '0000') === 0) pass(); else fail(`Expected 0, got ${hamHex('0000', '0000')}`);
  },
  'hamHex: counts bit differences across all hex digits': ({pass, fail}) => {
    // '0' vs 'f' differs in all 4 bits, times 4 digits = 16
    if(hamHex('0000', 'ffff') === 16) pass(); else fail(`Expected 16, got ${hamHex('0000', 'ffff')}`);
  },
  'hamHex: mixed digits sum correctly': ({pass, fail}) => {
    // '0'^'0'=0 bits, '0'^'f'=4 bits
    if(hamHex('00', '0f') === 4) pass(); else fail(`Expected 4, got ${hamHex('00', '0f')}`);
  },

  /* phash payload normalization */
  'phashHashes: legacy array payload returns itself': ({pass, fail}) => {
    const arr = ['0000', '1111'];
    if(phashHashes(arr) === arr) pass(); else fail('Expected same array reference back');
  },
  'phashHashes: object payload returns its .hashes': ({pass, fail}) => {
    const hashes = ['0000'];
    if(phashHashes({hashes, detail: 10}) === hashes) pass(); else fail('Expected .hashes extracted');
  },
  'phashHashes: null/undefined payload returns null': ({pass, fail}) => {
    if(phashHashes(null) === null && phashHashes(undefined) === null) pass();
    else fail('Expected null for null/undefined input');
  },
  'phashDetail: legacy array payload has unknown (null) detail': ({pass, fail}) => {
    if(phashDetail(['0000']) === null) pass(); else fail('Expected null detail for legacy array payload');
  },
  'phashDetail: object payload returns its .detail': ({pass, fail}) => {
    if(phashDetail({hashes: [], detail: 7}) === 7) pass(); else fail(`Expected 7, got ${phashDetail({hashes: [], detail: 7})}`);
  },
  'phashUsable: unknown detail fails open (usable)': ({pass, fail}) => {
    if(phashUsable(['0000'])) pass(); else fail('Legacy payload with unknown detail should be usable');
  },
  'phashUsable: detail below PHASH_MIN_DETAIL is not usable': ({pass, fail}) => {
    if(phashUsable({hashes: [], detail: 3}) === false) pass(); else fail('detail=3 should be below the usable floor');
  },
  'phashUsable: detail at/above PHASH_MIN_DETAIL is usable': ({pass, fail}) => {
    if(phashUsable({hashes: [], detail: 6})) pass(); else fail('detail=6 should meet the usable floor');
  },

  /* phashSim */
  'phashSim: identical single-orientation hashes score 1': ({pass, fail}) => {
    if(phashSim(['0000'], ['0000']) === 1) pass(); else fail(`Expected 1, got ${phashSim(['0000'], ['0000'])}`);
  },
  'phashSim: takes the best (min distance) across all offered orientations': ({pass, fail}) => {
    // 'ffff' is 16 bits away from '0000', but one of B's orientations is an exact match.
    const sim = phashSim(['0000'], ['ffff', '0000']);
    if(sim === 1) pass(); else fail(`Expected 1 (best orientation matched), got ${sim}`);
  },
  'phashSim: missing payload on either side scores 0': ({pass, fail}) => {
    if(phashSim(null, ['0000']) === 0 && phashSim(['0000'], null) === 0) pass();
    else fail('Expected 0 when either side has no usable payload');
  },

  /* cosine */
  'cosine: orthogonal vectors score 0': ({pass, fail}) => {
    if(cosine([1, 0], [0, 1]) === 0) pass(); else fail(`Expected 0, got ${cosine([1, 0], [0, 1])}`);
  },
  'cosine: computes the dot product': ({pass, fail}) => {
    if(cosine([1, 2, 3], [4, 5, 6]) === 32) pass(); else fail(`Expected 32, got ${cosine([1, 2, 3], [4, 5, 6])}`);
  },

  /* remap* tier calibrations — exact boundary values documented in lib/engine.js */
  'remapEmbed: floor (0.45) maps to 0, ceiling (0.99) maps to 1': ({pass, fail}) => {
    if(remapEmbed(0.45) === 0 && remapEmbed(0.99) === 1) pass();
    else fail(`Expected 0/1, got ${remapEmbed(0.45)}/${remapEmbed(0.99)}`);
  },
  'remapEmbed: below floor clamps to 0, above ceiling clamps to 1': ({pass, fail}) => {
    if(remapEmbed(0.1) === 0 && remapEmbed(1) === 1) pass();
    else fail(`Expected 0/1, got ${remapEmbed(0.1)}/${remapEmbed(1)}`);
  },
  'remapEmbed: decision boundary (0.93816) maps to exactly 0.5': ({pass, fail}) => {
    if(remapEmbed(0.93816) === 0.5) pass(); else fail(`Expected 0.5, got ${remapEmbed(0.93816)}`);
  },
  'remapPhash: floor (0.78) maps to 0, boundary (0.82) to 0.5, ceiling (0.98) to 1': ({pass, fail}) => {
    if(remapPhash(0.78) === 0 && remapPhash(0.82) === 0.5 && remapPhash(0.98) === 1) pass();
    else fail(`Expected 0/0.5/1, got ${remapPhash(0.78)}/${remapPhash(0.82)}/${remapPhash(0.98)}`);
  },
  'remapOrb: floor (0.013) maps to 0, boundary (0.03) to 0.5, ceiling (1.0) to 1': ({pass, fail}) => {
    if(remapOrb(0.013) === 0 && remapOrb(0.03) === 0.5 && remapOrb(1.0) === 1) pass();
    else fail(`Expected 0/0.5/1, got ${remapOrb(0.013)}/${remapOrb(0.03)}/${remapOrb(1.0)}`);
  },
  'remapSscd: floor (0.20) maps to 0, boundary (0.39) to 0.5, ceiling (0.95) to 1': ({pass, fail}) => {
    if(remapSscd(0.20) === 0 && remapSscd(0.39) === 0.5 && remapSscd(0.95) === 1) pass();
    else fail(`Expected 0/0.5/1, got ${remapSscd(0.20)}/${remapSscd(0.39)}/${remapSscd(0.95)}`);
  },

  /* pairEligible */
  'pairEligible: without any reference image, only search-vs-search pairs are eligible': ({pass, fail}) => {
    const items = [{search: true}, {search: true}];
    const include = pairEligible(items);
    if(include(items[0], items[1])) pass(); else fail('search x search should be eligible with no references present');
  },
  'pairEligible: with a reference present, search-vs-search is excluded': ({pass, fail}) => {
    const items = [{ref: true}, {search: true}, {search: true}];
    const include = pairEligible(items);
    if(!include(items[1], items[2])) pass();
    else fail('search x search must never be built once a reference image is present');
  },
  'pairEligible: with a reference present, reference-vs-search is eligible': ({pass, fail}) => {
    const items = [{ref: true}, {search: true}];
    const include = pairEligible(items);
    if(include(items[0], items[1])) pass(); else fail('ref x search should be eligible in reference mode');
  },

  /* buildCandidatePairs */
  'buildCandidatePairs: filters out pairs below the candidate floor when a cheap signal is enabled': ({pass, fail}) => {
    const items = [
      {search: true, embedding: [1, 0]},
      {search: true, embedding: [1, 0]}, // identical -> cosine 1 -> remapEmbed -> 1 (passes floor)
      {search: true, embedding: [0, 1]}, // orthogonal -> cosine 0 -> remapEmbed -> 0 (below floor)
    ];
    const pairs = buildCandidatePairs(items, {usePhash: false, useNN: true, useCopy: false});
    if(pairs.length === 1 && pairs[0].i === 0 && pairs[0].j === 1) pass();
    else fail(`Expected exactly the (0,1) pair, got ${JSON.stringify(pairs)}`);
  },
  'buildCandidatePairs: with every cheap signal disabled, every eligible pair passes through': ({pass, fail}) => {
    const items = [{search: true}, {search: true}, {search: true}];
    const pairs = buildCandidatePairs(items, {usePhash: false, useNN: false, useCopy: false});
    if(pairs.length === 3) pass(); else fail(`Expected all 3 pairs with no cheap signal to filter on, got ${pairs.length}`);
  },

  /* pairLinks / pairBest / pairStrength */
  'pairLinks: true when an enabled tier clears its own threshold': ({pass, fail}) => {
    const s = {usePhash: true, tPhash: 0.5};
    if(pairLinks({sPhash: 0.6}, s) && !pairLinks({sPhash: 0.4}, s)) pass();
    else fail('Expected 0.6 to clear a 0.5 threshold and 0.4 to not');
  },
  'pairLinks: a disabled tier never links regardless of its score': ({pass, fail}) => {
    const s = {usePhash: false, tPhash: 0.1};
    if(pairLinks({sPhash: 0.99}, s) === false) pass(); else fail('A disabled tier must not contribute a link');
  },
  'pairBest: reports the strongest signal among enabled tiers': ({pass, fail}) => {
    const s = {usePhash: true, useNN: true};
    const best = pairBest({sPhash: 0.3, sEmbed: 0.7}, s);
    if(best === 0.7) pass(); else fail(`Expected 0.7, got ${best}`);
  },
  'pairStrength: expresses score as a ratio of its tier threshold': ({pass, fail}) => {
    const s = {usePhash: true, tPhash: 0.4};
    const strength = pairStrength({sPhash: 0.2}, s);
    if(strength === 0.5) pass(); else fail(`Expected 0.5 (0.2/0.4), got ${strength}`);
  },

  /* clusterPairs */
  'clusterPairs: fully cohesive triangle merges into one group': ({pass, fail}) => {
    const items = [{search: true, hash: 'h0'}, {search: true, hash: 'h1'}, {search: true, hash: 'h2'}];
    const pairs = [
      {i: 0, j: 1, sPhash: 0.9, sEmbed: 0, sSscd: 0, sOrb: null},
      {i: 1, j: 2, sPhash: 0.9, sEmbed: 0, sSscd: 0, sOrb: null},
      {i: 0, j: 2, sPhash: 0.9, sEmbed: 0, sSscd: 0, sOrb: null},
    ];
    const s = {usePhash: true, tPhash: 0.5, cohesion: 0.5, maxGroupSize: 10};
    const groups = clusterPairs(items, pairs, s);
    const members = groups[0]?.members?.slice().sort();
    if(groups.length === 1 && JSON.stringify(members) === JSON.stringify([0, 1, 2])) pass();
    else fail(`Expected one group of [0,1,2], got ${JSON.stringify(groups)}`);
  },
  'clusterPairs: cohesion guard blocks a weak transitive chain from merging': ({pass, fail}) => {
    const items = [{search: true, hash: 'h0'}, {search: true, hash: 'h1'}, {search: true, hash: 'h2'}];
    // 0-1 and 1-2 are strongly linked, but 0-2 was never even a candidate (no pair built,
    // i.e. similarity 0) — the complete-linkage cohesion check must stop all three from
    // being chained into a single group through the shared middle image.
    const pairs = [
      {i: 0, j: 1, sPhash: 0.95, sEmbed: 0, sSscd: 0, sOrb: null},
      {i: 1, j: 2, sPhash: 0.90, sEmbed: 0, sSscd: 0, sOrb: null},
    ];
    const s = {usePhash: true, tPhash: 0.5, cohesion: 0.5, maxGroupSize: 10};
    const groups = clusterPairs(items, pairs, s);
    const members = groups[0]?.members?.slice().sort();
    if(groups.length === 1 && JSON.stringify(members) === JSON.stringify([0, 1])) pass();
    else fail(`Expected only [0,1] to merge (2 left out by the cohesion guard), got ${JSON.stringify(groups)}`);
  },
  'clusterPairs: a user-excluded pair is never merged, even when strongly linked': ({pass, fail}) => {
    const items = [{search: true, hash: 'ha'}, {search: true, hash: 'hb'}];
    const pairs = [{i: 0, j: 1, sPhash: 0.9, sEmbed: 0, sSscd: 0, sOrb: null}];
    const s = {usePhash: true, tPhash: 0.5, cohesion: 0, maxGroupSize: 10};
    const excluded = new Set([pairKey('ha', 'hb')]);
    const groups = clusterPairs(items, pairs, s, excluded);
    if(groups.length === 0) pass(); else fail(`Expected no groups (excluded pair), got ${JSON.stringify(groups)}`);
  },
  'clusterPairs: a group can never contain more than one reference image': ({pass, fail}) => {
    const items = [
      {ref: true, hash: 'r1'},
      {ref: true, hash: 'r2'},
      {search: true, hash: 's1'},
    ];
    // Both references independently match the same search image (no ref-vs-ref pair, as
    // buildCandidatePairs would never build one) — only the stronger link may win.
    const pairs = [
      {i: 0, j: 2, sPhash: 0.9, sEmbed: 0, sSscd: 0, sOrb: null},
      {i: 1, j: 2, sPhash: 0.9, sEmbed: 0, sSscd: 0, sOrb: null},
    ];
    const s = {usePhash: true, tPhash: 0.5, cohesion: 0, maxGroupSize: 10};
    const groups = clusterPairs(items, pairs, s);
    const members = groups[0]?.members?.slice().sort();
    if(groups.length === 1 && JSON.stringify(members) === JSON.stringify([0, 2])) pass();
    else fail(`Expected only [0,2] (first-processed reference wins), got ${JSON.stringify(groups)}`);
  },

  /* embedding base64 round-trip */
  'embToB64 / b64ToEmb: round-trips a float embedding': ({pass, fail}) => {
    const original = [0.1, -0.5, 2.25, 0];
    const restored = b64ToEmb(embToB64(original));
    const close = original.every((v, i) => Math.abs(v - restored[i]) < 1e-6);
    if(close) pass(); else fail(`Expected ${JSON.stringify(original)}, got ${JSON.stringify(restored)}`);
  },
};
