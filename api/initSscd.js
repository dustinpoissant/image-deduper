import path from 'path';
import { fileURLToPath } from 'url';
import { initSscd as load } from '../src/sscd.js';

/**
 * Load the SSCD copy-detection model.
 *
 * Unlike the DINOv2 tier (which transformers.js pulls from the HF hub on first run), SSCD
 * has no published ONNX, so the file is produced by tools/sscd/convert.py and resolved
 * from disk. Resolution order:
 *   1. SSCD_MODEL_PATH env var — used by the calibration harness and for local testing
 *   2. models/sscd_disc_mixup.onnx next to the app
 *
 * Returns { ok, path } or { ok:false, error } — the tier degrades to "unavailable" rather
 * than failing the whole scan, matching how the geometric tier handles a missing OpenCV.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = path.join(HERE, '..', 'models', 'sscd_disc_mixup.onnx');

export default async function initSscd() {
  const modelPath = process.env.SSCD_MODEL_PATH || DEFAULT_MODEL;
  try {
    const info = await load(modelPath);
    return { ok: true, path: modelPath, ...info };
  } catch (e) {
    const missing = e?.code === 'ENOENT';
    return {
      ok: false,
      error: missing
        ? `SSCD model not found at ${modelPath}. Build it with tools/sscd/convert.py, or set SSCD_MODEL_PATH.`
        : String(e?.message || e)
    };
  }
}
