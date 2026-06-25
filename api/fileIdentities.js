import { createReadStream, promises as fs } from 'fs';
import { createHash } from 'crypto';

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const s = createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Content identity for files: SHA-256 of the bytes (so a rename/move keeps the
 * same identity), plus size/mtime so the renderer can skip re-hashing unchanged
 * paths next time. Per-file errors are captured, not thrown.
 * @param {string[]} paths
 * @returns {Promise<Array<{path,size,mtime,hash}|{path,error}>>}
 */
export default async function fileIdentities(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const st = await fs.stat(p);
      const hash = await sha256File(p);
      out.push({ path: p, size: st.size, mtime: st.mtimeMs, hash });
    } catch (e) {
      out.push({ path: p, error: String(e?.message || e) });
    }
  }
  return out;
}
