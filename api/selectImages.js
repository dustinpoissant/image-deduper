import { dialog, BrowserWindow } from 'electron';

/** Opens the native image-file picker (multi-select). Returns string[] of chosen paths. */
export default async function selectImages() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Select image(s) to add',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif'] }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths;
}
