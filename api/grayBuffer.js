import sharp from 'sharp';
import { promises as fs } from 'fs';

sharp.cache(false); // don't keep source files mmap'd/locked

/**
 * Decode an image to a downscaled raw grayscale buffer for renderer-side ORB.
 * Reads bytes ourselves and hands sharp a Buffer so the file is never left open.
 * @param {string} p path
 * @param {number} size longest edge
 * @returns {Promise<{width:number,height:number,data:string}|null>} base64 raw 8-bit gray
 */
export default async function grayBuffer(p, size = 512) {
  try {
    const buf = await fs.readFile(p);
    const { data, info } = await sharp(buf, { failOn: 'none' })
      .rotate().greyscale().resize(size, size, { fit: 'inside' })
      .raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: data.toString('base64') };
  } catch {
    return null;
  }
}
