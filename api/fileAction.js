import { shell, app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/* ---------- move helper ----------
   fs.rename fails across filesystems (EXDEV) — real for macOS's app-managed trash,
   since userData lives on the system volume but a source image can be on any mounted
   drive. Falls back to copy+delete, which works across any two paths. */
async function moveFile(src, dest) {
  try {
    await fs.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fs.copyFile(src, dest);
    await fs.unlink(src);
  }
}

/* ---------- Windows: restore-from-Recycle-Bin via Shell.Application COM ----------
   Windows keeps enough metadata on a recycled file (its real filesystem location under
   $Recycle.Bin, plus the folder it was deleted from) that "restore" can just move the raw
   file back — no need to reimplement Explorer's own Restore. Verified empirically against
   a real Recycle Bin: a FolderItem's .Path in the Namespace(10) (Recycle Bin) view is the
   actual $R... file on disk, not a virtualized path, so Move-Item works on it directly; and
   ExtendedProperty('System.Recycle.DeletedFrom') is a locale-independent PKEY (unlike the
   "Original Location" column label, which is localized) giving the original folder. The
   companion $I... metadata file is cleaned up afterward so nothing lingers in the bin. */
const WIN_RESTORE_PS = `
param([Parameter(Mandatory)][string]$Target)
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$rb = $shell.Namespace(10)
$best = $null
$bestDate = [DateTime]::MinValue
foreach ($item in $rb.Items()) {
  try {
    $deletedFrom = $item.ExtendedProperty('System.Recycle.DeletedFrom')
    if (-not $deletedFrom) { continue }
    $origFull = Join-Path $deletedFrom $item.Name
    if ($origFull -ieq $Target) {
      $d = $item.ExtendedProperty('System.Recycle.DateDeleted')
      if ($null -eq $best -or $d -gt $bestDate) { $best = $item; $bestDate = $d }
    }
  } catch {}
}
if (-not $best) { Write-Output 'NOTFOUND'; exit 0 }
if (Test-Path -LiteralPath $Target) { Write-Output 'CONFLICT'; exit 0 }
$rawPath = $best.Path
$destDir = Split-Path -Parent $Target
if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
Move-Item -LiteralPath $rawPath -Destination $Target -Force
$leaf = Split-Path -Leaf $rawPath
$infoPath = Join-Path (Split-Path -Parent $rawPath) ('$I' + $leaf.Substring(2))
Remove-Item -LiteralPath $infoPath -Force -ErrorAction SilentlyContinue
Write-Output 'OK'
`;

// Written once to a stable file rather than passed inline: PowerShell's -Command re-parses
// trailing argv as more script text (arbitrary paths would need PowerShell-escaping, not
// just shell-escaping), while -File binds argv to $Target as a literal string — safe for any
// path, quotes/spaces/$ and all. Verified against paths containing those characters.
let winRestoreScriptPath = null;
async function ensureWinRestoreScript() {
  if (winRestoreScriptPath) return winRestoreScriptPath;
  const dir = path.join(app.getPath('userData'), 'scripts');
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, 'restore-from-recyclebin.ps1');
  await fs.writeFile(p, WIN_RESTORE_PS, 'utf8');
  winRestoreScriptPath = p;
  return p;
}

function runPowerShell(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args
    ], { windowsHide: true });
    let out = '', err = '';
    ps.stdout.on('data', d => out += d);
    ps.stderr.on('data', d => err += d);
    ps.on('error', reject);
    ps.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `powershell exited ${code}`)));
  });
}

async function restoreWindows(originalPath) {
  const script = await ensureWinRestoreScript();
  const result = await runPowerShell(script, ['-Target', originalPath]);
  if (result === 'OK') return { ok: true };
  if (result === 'CONFLICT') return { ok: false, error: 'A file already exists at the original location.' };
  return { ok: false, error: 'Could not find this file in the Recycle Bin — it may have been permanently deleted or already restored.' };
}

/* ---------- Linux: restore via the freedesktop.org trash spec ----------
   Covers the common case: a file trashed from the user's home filesystem, tracked in
   $XDG_DATA_HOME/Trash (default ~/.local/share/Trash) as a pair of files — the data under
   files/ and its metadata (original Path, DeletionDate) under info/*.trashinfo. A file
   trashed from a *different* mounted filesystem (an external drive) uses that filesystem's
   own per-mount .Trash/$uid can, which this doesn't search — restoring one of those reports
   "not found" even though the file is still sitting in that drive's own trash, recoverable
   by hand. */
async function restoreLinux(originalPath) {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const trashDir = path.join(dataHome, 'Trash');
  const infoDir = path.join(trashDir, 'info');
  const filesDir = path.join(trashDir, 'files');

  let entries;
  try { entries = await fs.readdir(infoDir); } catch { return { ok: false, error: 'Could not find this file in Trash.' }; }

  let best = null, bestDate = 0;
  for (const name of entries) {
    if (!name.endsWith('.trashinfo')) continue;
    let content;
    try { content = await fs.readFile(path.join(infoDir, name), 'utf8'); } catch { continue; }
    const pathMatch = content.match(/^Path=(.*)$/m);
    if (!pathMatch) continue;
    let decoded = decodeURIComponent(pathMatch[1].trim());
    if (!path.isAbsolute(decoded)) decoded = path.join(trashDir, '..', decoded);
    if (decoded !== originalPath) continue;
    const dateMatch = content.match(/^DeletionDate=(.*)$/m);
    const t = dateMatch ? (Date.parse(dateMatch[1].trim()) || 0) : 0;
    if (!best || t > bestDate) { best = name; bestDate = t; }
  }
  if (!best) return { ok: false, error: 'Could not find this file in Trash — it may have been permanently deleted or already restored.' };

  const baseName = best.slice(0, -'.trashinfo'.length);
  const trashedFile = path.join(filesDir, baseName);
  try { await fs.access(originalPath); return { ok: false, error: 'A file already exists at the original location.' }; } catch { /* clear to restore */ }
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await moveFile(trashedFile, originalPath);
  await fs.rm(path.join(infoDir, best), { force: true });
  return { ok: true };
}

/* ---------- macOS: app-managed trash ----------
   There's no public API to programmatically "Put Back" a file trashed via NSWorkspace /
   NSFileManager (Finder's Put Back relies on extended attributes only Finder itself sets),
   so undo can't be layered reliably on top of the real macOS Trash. Instead, trashing on
   macOS moves the file into our own folder under userData — restoring it is then a plain,
   always-reliable move back — at the cost of the file not showing up in Finder's Trash while
   an undo is still possible for it. finalizeMacTrash() (called once an entry falls out of
   the undo history, or on the next launch for anything left over from a session that ended
   before that happened) hands the file off to the real Trash, so nothing lingers hidden
   forever. */
const macTrashDir = () => path.join(app.getPath('userData'), 'AppTrash');

async function macTrash(p) {
  const dir = macTrashDir();
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${crypto.randomUUID()}__${path.basename(p)}`);
  await moveFile(p, dest);
  return { ok: true, trashedPath: dest };
}

async function macRestore(originalPath, trashedPath) {
  if (!trashedPath) return { ok: false, error: 'No trashed copy on record.' };
  try { await fs.access(trashedPath); } catch { return { ok: false, error: 'This file is no longer available to restore.' }; }
  try { await fs.access(originalPath); return { ok: false, error: 'A file already exists at the original location.' }; } catch { /* clear to restore */ }
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  await moveFile(trashedPath, originalPath);
  return { ok: true };
}

async function finalizeMacTrash(trashedPath) {
  if (!trashedPath) return { ok: true };
  try { await fs.access(trashedPath); } catch { return { ok: true }; }
  await shell.trashItem(trashedPath);
  return { ok: true };
}

async function sweepMacTrash() {
  let entries;
  try { entries = await fs.readdir(macTrashDir()); } catch { return { ok: true, swept: 0 }; }
  let swept = 0;
  for (const name of entries) {
    try { await shell.trashItem(path.join(macTrashDir(), name)); swept++; } catch { /* leave it, try again next launch */ }
  }
  return { ok: true, swept };
}

/**
 * Perform a filesystem action on an image.
 * @param {'reveal'|'open'|'trash'|'restore'|'finalizeTrash'|'sweepTrash'} action
 * @param {string} [p] path — the file (reveal/open/trash), the original path to restore to
 *   (restore), or the trashed copy to release (finalizeTrash). Unused for sweepTrash.
 * @param {string} [trashedPath] restore only, macOS only — the trashedPath a matching
 *   'trash' call returned. Windows/Linux ignore it and look the file up by its original
 *   path instead.
 */
export default async function fileAction(action, p, trashedPath) {
  try {
    if (action === 'reveal') { shell.showItemInFolder(p); return { ok: true }; }
    if (action === 'open') { const err = await shell.openPath(p); return { ok: !err, error: err || undefined }; }
    if (action === 'trash') {
      if (process.platform === 'darwin') return await macTrash(p);
      await shell.trashItem(p);
      return { ok: true };
    }
    if (action === 'restore') {
      if (process.platform === 'win32') return await restoreWindows(p);
      if (process.platform === 'darwin') return await macRestore(p, trashedPath);
      return await restoreLinux(p);
    }
    if (action === 'finalizeTrash') {
      if (process.platform === 'darwin') return await finalizeMacTrash(p);
      return { ok: true };
    }
    if (action === 'sweepTrash') {
      if (process.platform === 'darwin') return await sweepMacTrash();
      return { ok: true, swept: 0 };
    }
    return { ok: false, error: 'unknown action: ' + action };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
