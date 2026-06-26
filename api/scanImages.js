import { promises as fs } from 'fs';
import path from 'path';

const EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp',
  '.tiff', '.tif', '.avif', '.heic', '.heif'
]);

/**
 * List image files for the given sources. Each source is either a folder (walked,
 * optionally recursively) or a single image file. Bare strings are treated as folders
 * for backward compatibility.
 * @param {Array<{path:string, kind?:'file'|'folder'}|string>|string} sources
 * @param {{recursive?: boolean}} opts
 * @returns {Promise<Array<{path,name,dir,size,mtime,ext}>>}
 */
export default async function scanImages(sources, opts = {}) {
  const recursive = opts.recursive !== false;
  const out = [];
  const seen = new Set();

  async function addFile(full, dir) {
    const ext = path.extname(full).toLowerCase();
    if (!EXT.has(ext) || seen.has(full)) return;
    seen.add(full);
    let size = 0, mtime = 0;
    try { const st = await fs.stat(full); size = st.size; mtime = st.mtimeMs; } catch { return; }
    out.push({ path: full, name: path.basename(full), dir, size, mtime, ext });
  }

  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) await walk(full);
      } else if (e.isFile()) {
        await addFile(full, dir);
      }
    }
  }

  const list = (Array.isArray(sources) ? sources : [sources])
    .map(s => (typeof s === 'string' ? { path: s, kind: 'folder' } : s))
    .filter(s => s && s.path);

  for (const s of list) {
    if (s.kind === 'file') await addFile(s.path, path.dirname(s.path));
    else await walk(s.path);
  }
  return out;
}
