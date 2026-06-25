import { promises as fs } from 'fs';
import path from 'path';

const EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
  '.tiff', '.tif', '.avif', '.heic', '.heif'
]);

/**
 * Recursively list image files in the given directories.
 * @param {string|string[]} dirs
 * @param {{recursive?: boolean}} opts
 * @returns {Promise<Array<{path,name,dir,size,mtime,ext}>>}
 */
export default async function scanImages(dirs, opts = {}) {
  const recursive = opts.recursive !== false;
  const out = [];
  const seen = new Set();

  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(full);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (!EXT.has(ext) || seen.has(full)) continue;
        seen.add(full);
        let size = 0, mtime = 0;
        try { const st = await fs.stat(full); size = st.size; mtime = st.mtimeMs; } catch { /* ignore */ }
        out.push({ path: full, name: e.name, dir, size, mtime, ext });
      }
    }
  }

  for (const d of (Array.isArray(dirs) ? dirs : [dirs])) await walk(d);
  return out;
}
