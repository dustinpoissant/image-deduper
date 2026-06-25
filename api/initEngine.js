import { initModel } from '../src/engine.js';

/**
 * Load the neural embedding model. Tries GPU execution providers first (when
 * preferGPU) and falls back to CPU. Returns { ok, device, model } or { ok:false, error }.
 */
export default async function initEngine(opts = {}) {
  const candidates = opts.preferGPU
    ? ['dml', 'cuda', 'webgpu', 'cpu']
    : ['cpu'];
  try {
    const info = await initModel(candidates);
    return { ok: true, ...info };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
