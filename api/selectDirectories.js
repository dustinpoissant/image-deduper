import { dialog, BrowserWindow } from 'electron';

/** Opens the native folder picker (multi-select). Returns string[] of chosen paths. */
export default async function selectDirectories() {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Select folder(s) to scan for duplicates',
    properties: ['openDirectory', 'multiSelections']
  });
  if (res.canceled) return [];
  return res.filePaths;
}
