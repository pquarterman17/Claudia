import type { HostPlatform } from '@claudia/shared';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';

const WIN_PICKER_SCRIPT = join(import.meta.dirname, '..', 'scripts', 'pick-folder.ps1');

/**
 * Opens the host's native folder dialog and returns the chosen absolute path.
 *
 * The browser deliberately cannot see real filesystem paths — `showDirectoryPicker`
 * hands back a handle, not a path — so the picker has to run server-side. That
 * works because Claudia's server is the user's own machine; the dialog appears on
 * the same desktop as the browser. (It would be wrong for a remote server, which
 * is one more reason multi-host is out of scope.)
 */
const PICKERS: Record<HostPlatform, { file: string; args: string[] }> = {
  // -STA because shell dialogs need a single-threaded apartment. The script
  // itself is where the interesting parts live — see pick-folder.ps1.
  win32: {
    file: 'powershell.exe',
    args: ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', WIN_PICKER_SCRIPT],
  },
  darwin: {
    file: 'osascript',
    args: ['-e', 'POSIX path of (choose folder with prompt "Select a working directory for Claudia")'],
  },
  linux: {
    file: 'zenity',
    args: ['--file-selection', '--directory', '--title=Select a working directory for Claudia'],
  },
};

/** A cancel looks like a failure on some platforms; these say otherwise. */
const CANCEL_HINTS = [/user canceled/i, /user cancelled/i];

/**
 * Resolves to the chosen path, or null if the user cancelled. Rejects if the
 * picker genuinely failed.
 *
 * Distinguishing the two matters: an earlier version treated every non-zero
 * exit as a cancel, so a broken picker was indistinguishable from the user
 * changing their mind — the button just went quiet and the real error was lost.
 */
export function pickFolder(platform: HostPlatform, startIn?: string): Promise<string | null> {
  const picker = PICKERS[platform];
  const args = startIn ? [...picker.args, startIn] : picker.args;
  return new Promise((resolve, reject) => {
    execFile(picker.file, args, { timeout: 180_000 }, (err, stdout, stderr) => {
      const chosen = stdout.trim();
      if (chosen) {
        resolve(normalizePath(chosen));
        return;
      }
      const message = String(stderr ?? '').trim();
      // Exit 0 with no output, or an explicit "cancelled", means cancelled.
      if (!err || CANCEL_HINTS.some((re) => re.test(message))) {
        resolve(null);
        return;
      }
      reject(new Error(message || `Folder picker exited unexpectedly (${picker.file})`));
    });
  });
}

/**
 * Cleans a path the user pasted. Windows "Copy as path" wraps it in quotes, and
 * dragged or copied paths often carry stray whitespace.
 *
 * Separators are also canonicalised on Windows, where both slashes work: without
 * it `C:\x` and `C:/x` are the same directory but compare unequal, so the recents
 * list accumulates duplicate entries for one folder.
 */
export function normalizePath(raw: string, platform: NodeJS.Platform = process.platform): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
  if (platform === 'win32') p = p.replace(/\//g, '\\');
  // Drop a trailing separator so `C:\x` and `C:\x\` are one entry, but keep a
  // bare root (`C:\`, `/`) intact.
  if (p.length > 1 && /[\\/]$/.test(p) && !/^[a-zA-Z]:[\\/]$/.test(p)) p = p.slice(0, -1);
  return p;
}

/** Throws with a readable message if the path is not a usable working directory. */
export function assertUsableDirectory(path: string): void {
  if (!path) throw new Error('Working directory is required');
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`No such directory: ${path}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
}
