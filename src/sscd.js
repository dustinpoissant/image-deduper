/**
 * Tier 4 - SSCD copy-detection descriptor (main process / Node).
 *
 * Why this exists alongside the DINOv2 tier: DINOv2 is a general-purpose *semantic*
 * model. Rating "same person, same pose, different outfit and location" as highly similar
 * is what it was trained to do — which is exactly the false positive users hit on a real
 * photo library. SSCD is trained on the opposite objective: match transformed *copies* of
 * one image, and explicitly NOT different photos of the same subject.
 * ("A Self-Supervised Descriptor for Image Copy Detection", Pizzi et al., CVPR 2022.)
 *
 * Upstream ships TorchScript only, so the .onnx here is produced by an offline conversion
 * (see tools/sscd/convert.py). The app only ever loads the .onnx — no PyTorch at runtime.
 *
 * Input contract, from the upstream README:
 *   320x320 RGB, ImageNet normalization, NCHW float32.
 *   GeM pooling is inside the graph; output is a 512-d L2-normalized descriptor, so it
 *   drops straight into the same cosine() comparison the DINOv2 embeddings use.
 */

import sharp from 'sharp';
import { promises as fs } from 'fs';

sharp.cache(false); // never leave source files mmap'd/locked (same reason as src/engine.js)

const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

let _session = null;
let _ort = null;

/**
 * Load the ONNX session. `modelPath` must point at the converted sscd_disc_mixup.onnx.
 * Returns { dim } on success.
 */
export async function initSscd(modelPath) {
  if (_session) return { dim: 512 };
  _ort = (await import('onnxruntime-node')).default ?? (await import('onnxruntime-node'));
  await fs.access(modelPath); // fail with a clear error rather than deep inside ORT
  _session = await _ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  });
  return { dim: 512 };
}

export function sscdReady() { return !!_session; }

export function disposeSscd() { _session = null; }

/**
 * 512-d L2-normalized copy-detection descriptor for an image. Returns number[].
 *
 * Decoding mirrors src/engine.js embed(): we hand sharp a Buffer we read ourselves (so the
 * file is never held open), honour EXIF rotation, and flatten alpha onto white so
 * transparent PNGs don't decode as black.
 */
export async function embedSscd(path) {
  if (!_session) throw new Error('SSCD model not initialised');
  const { data } = await sharp(await fs.readFile(path), { failOn: 'none' })
    .rotate().flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha()
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });

  // HWC uint8 -> NCHW float32, normalized. Upstream resizes to a square tensor, so the
  // aspect distortion is applied identically to both images in any comparison.
  const plane = SIZE * SIZE;
  const chw = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    const j = i * 3;
    chw[i] = (data[j] / 255 - MEAN[0]) / STD[0];
    chw[plane + i] = (data[j + 1] / 255 - MEAN[1]) / STD[1];
    chw[2 * plane + i] = (data[j + 2] / 255 - MEAN[2]) / STD[2];
  }

  const input = new _ort.Tensor('float32', chw, [1, 3, SIZE, SIZE]);
  const out = await _session.run({ [_session.inputNames[0]]: input });
  const vec = out[_session.outputNames[0]].data;

  // Already L2-normalized by the graph; renormalize defensively so cosine() stays exact.
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  const res = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) res[i] = vec[i] / n;
  return res;
}
