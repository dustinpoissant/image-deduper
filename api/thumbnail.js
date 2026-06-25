import sharp from 'sharp';
import { promises as fs } from 'fs';

sharp.cache(false); // don't keep source files mmap'd/locked

/**
 * Produce a small EXIF-oriented webp data URL for preview, plus original dimensions.
 * Reads bytes ourselves and hands sharp a Buffer so the file is never left open.
 * @param {string} p image path
 * @param {number} max longest edge of the thumbnail
 */
export default async function thumbnail(p, max = 256) {
  try {
    const buf = await fs.readFile(p);
    const img = sharp(buf, { failOn: 'none' }).rotate(); // auto-orient via EXIF
    const meta = await img.metadata();
    const out = await img
      .resize(max, max, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return {
      dataUrl: 'data:image/webp;base64,' + out.toString('base64'),
      width: meta.width || null,
      height: meta.height || null
    };
  } catch {
    return null;
  }
}
