import { shell } from 'electron';

/**
 * Perform a filesystem action on an image.
 * @param {'reveal'|'open'|'trash'} action
 * @param {string} p path
 */
export default async function fileAction(action, p) {
  try {
    if (action === 'reveal') { shell.showItemInFolder(p); return { ok: true }; }
    if (action === 'open') { const err = await shell.openPath(p); return { ok: !err, error: err || undefined }; }
    if (action === 'trash') { await shell.trashItem(p); return { ok: true }; }
    return { ok: false, error: 'unknown action: ' + action };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
