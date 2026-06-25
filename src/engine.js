/**
 * Detection engine (main process / Node).
 *
 * Three independent, gracefully-degrading tiers:
 *   1. pHash         - cheap 64-bit DCT hash (+ 8 dihedral orientations). Catches
 *                      exact dupes, rescales, recompression and 90deg rotations / flips.
 *   2. NN embeddings - DINOv2 feature vector per image via @huggingface/transformers
 *                      (native onnxruntime-node, GPU w/ CPU fallback). Robust to crop,
 *                      arbitrary rotation, scale, filters/tone and watermark overlays.
 *   3. ORB geometric - feature matching + RANSAC homography (opencv-js, WASM). Only run
 *                      on borderline candidate pairs to verify a true geometric overlap.
 */

import sharp from 'sharp';
import { promises as fs } from 'fs';

// Disable libvips' operation cache so it never holds the source file open (mmap'd),
// which otherwise locks the file on Windows. We also feed sharp a Buffer we read
// ourselves (see readImage) so sharp never opens the path directly.
sharp.cache(false);

const readImage = (p) => fs.readFile(p);

/* ------------------------------------------------------------------ *
 *  Tier 1 - Perceptual hash (pHash)
 * ------------------------------------------------------------------ */

const HSIZE = 32; // resize target before DCT
const HLOW = 8;   // low-frequency block kept -> 64 bits

function dct1d(v) {
  const N = v.length;
  const out = new Array(N);
  for (let u = 0; u < N; u++) {
    let s = 0;
    for (let x = 0; x < N; x++) s += v[x] * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
    out[u] = s * (u === 0 ? Math.SQRT1_2 : 1);
  }
  return out;
}

function dct2d(m) {
  const N = m.length;
  const rows = m.map(dct1d);
  const out = Array.from({ length: N }, () => new Array(N));
  for (let x = 0; x < N; x++) {
    const col = new Array(N);
    for (let y = 0; y < N; y++) col[y] = rows[y][x];
    const dc = dct1d(col);
    for (let y = 0; y < N; y++) out[y][x] = dc[y];
  }
  return out;
}

function rot90(m) {
  const N = m.length;
  const o = Array.from({ length: N }, () => new Array(N));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) o[x][N - 1 - y] = m[y][x];
  return o;
}
const flip = (m) => m.map((r) => r.slice().reverse());

function orientations(m) {
  const out = [];
  let cur = m;
  for (let i = 0; i < 4; i++) {
    out.push(cur);
    out.push(flip(cur));
    cur = rot90(cur);
  }
  return out; // 4 rotations x {identity, mirror} = 8 dihedral variants
}

function hashMatrix(m) {
  const d = dct2d(m);
  const vals = [];
  for (let y = 0; y < HLOW; y++) for (let x = 0; x < HLOW; x++) vals.push(d[y][x]);
  const tail = vals.slice(1).sort((a, b) => a - b);
  const med = tail[tail.length >> 1];
  let hex = '', nib = 0, cnt = 0;
  for (let i = 0; i < 64; i++) {
    nib = (nib << 1) | (vals[i] > med ? 1 : 0);
    if (++cnt === 4) { hex += nib.toString(16); nib = 0; cnt = 0; }
  }
  return hex;
}

/** Returns an array of 8 hex hashes (one per dihedral orientation). */
export async function phash(path) {
  const { data } = await sharp(await readImage(path)).greyscale().resize(HSIZE, HSIZE, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });
  const base = [];
  for (let y = 0; y < HSIZE; y++) {
    const r = new Array(HSIZE);
    for (let x = 0; x < HSIZE; x++) r[x] = data[y * HSIZE + x];
    base.push(r);
  }
  return orientations(base).map(hashMatrix);
}

/* ------------------------------------------------------------------ *
 *  Tier 2 - Neural embeddings (DINOv2 via transformers.js)
 * ------------------------------------------------------------------ */

let _model = null; // { extractor, RawImage, device, name }

/**
 * Initialise the embedding model. `deviceCandidates` is tried in order, falling
 * back to CPU. Returns { device, model }.
 */
export async function initModel(deviceCandidates = ['cpu']) {
  if (_model) return { device: _model.device, model: _model.name };
  const tf = await import('@huggingface/transformers');
  const { pipeline, env, RawImage } = tf;
  env.allowLocalModels = false; // download from the HF hub on first run
  const name = 'Xenova/dinov2-small';
  let lastErr;
  for (const device of deviceCandidates) {
    try {
      const extractor = await pipeline('image-feature-extraction', name, { device });
      _model = { extractor, RawImage, device, name };
      return { device, model: name };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Failed to initialise embedding model');
}

/** Mean-pooled, L2-normalised embedding for an image. Returns number[]. */
export async function embed(path) {
  if (!_model) throw new Error('Model not initialised');
  // Decode ourselves to raw RGB and build a RawImage directly. This avoids
  // transformers' bundled libvips loader which fails on some colourspaces.
  const { data, info } = await sharp(await readImage(path), { failOn: 'none' })
    .rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const img = new _model.RawImage(new Uint8ClampedArray(data), info.width, info.height, 3);
  const out = await _model.extractor(img);
  const feat = out.data;
  const dims = out.dims;
  let vec;
  if (dims.length === 3) {
    const T = dims[1], D = dims[2];
    vec = new Float32Array(D);
    for (let t = 0; t < T; t++) for (let d = 0; d < D; d++) vec[d] += feat[t * D + d];
    for (let d = 0; d < D; d++) vec[d] /= T;
  } else {
    vec = Float32Array.from(feat);
  }
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return Array.from(vec);
}

// Tier 3 (ORB geometric verification) runs in the renderer — see pages/index.html.
// OpenCV-JS WASM synchronously blocks the Node main process, so it cannot live here.
