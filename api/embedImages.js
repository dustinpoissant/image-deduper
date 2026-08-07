import { phash, embed } from '../src/engine.js';
import { embedSscd, sscdReady } from '../src/sscd.js';

/**
 * Compute pHash + neural embedding + SSCD descriptor for a batch of image paths. Per-image
 * failures are captured (not thrown) so one bad file does not abort the scan.
 * @param {string[]} paths
 * @param {{useNN?: boolean, usePhash?: boolean, useCopy?: boolean}} opts
 */
export default async function embedImages(paths, opts = {}) {
  const useNN = opts.useNN !== false;
  const usePhash = opts.usePhash !== false;
  // Only when the model actually loaded — initSscd reports failure rather than throwing,
  // so a missing model file degrades this tier instead of breaking the scan.
  const useCopy = opts.useCopy === true && sscdReady();
  // Each image's decode/resize (sharp/libvips) and inference (onnxruntime) runs
  // concurrently rather than strictly one-at-a-time — sharp's native work happens
  // on its own thread pool, and ONNX Runtime sessions tolerate concurrent run()s,
  // so this lets a batch actually spread across cores instead of serializing.
  return Promise.all(paths.map(async (p) => {
    const r = { path: p };
    if (usePhash) {
      try { r.phash = await phash(p); } catch (e) { r.phashError = String(e?.message || e); }
    }
    if (useNN) {
      try { r.embedding = await embed(p); } catch (e) { r.embedError = String(e?.message || e); }
    }
    if (useCopy) {
      try { r.sscd = await embedSscd(p); } catch (e) { r.sscdError = String(e?.message || e); }
    }
    return r;
  }));
}
