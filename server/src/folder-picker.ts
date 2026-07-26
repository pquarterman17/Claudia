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
    // `with multiple selections allowed` returns a list; one POSIX path per line.
    args: [
      '-e',
      'set dirs to choose folder with prompt "Select working directories for Claudia" with multiple selections allowed',
      '-e',
      'set out to ""',
      '-e',
      'repeat with d in dirs',
      '-e',
      'set out to out & POSIX path of d & linefeed',
      '-e',
      'end repeat',
      '-e',
      'return out',
    ],
  },
  linux: {
    file: 'zenity',
    args: [
      '--file-selection',
      '--directory',
      '--multiple',
      '--separator=\n',
      '--title=Select working directories for Claudia',
    ],
  },
};

/** A cancel looks like a failure on some platforms; these say otherwise. */
const CANCEL_HINTS = [/user canceled/i, /user cancelled/i];

/**
 * Resolves to the chosen paths — several when the user ctrl-clicks — or an
 * empty list if they cancelled. Rejects if the picker genuinely failed.
 *
 * Distinguishing the two matters: an earlier version treated every non-zero
 * exit as a cancel, so a broken picker was indistinguishable from the user
 * changing their mind — the button just went quiet and the real error was lost.
 */
export function pickFolders(platform: HostPlatform, startIn?: string): Promise<string[]> {
  const picker = PICKERS[platform];
  const args = startIn ? [...picker.args, startIn] : picker.args;
  return new Promise((resolve, reject) => {
    execFile(picker.file, args, { timeout: 180_000 }, (err, stdout, stderr) => {
      const chosen = stdout.trim();
      if (chosen) {
        // The picker prints one path per line; ctrl-clicking several folders
        // starts a session in each.
        resolve(
          chosen
            .split(/\r?\n/)
            .map((line) => normalizePath(line))
            .filter(Boolean),
        );
        return;
      }
      const message = String(stderr ?? '').trim();
      // Exit 0 with no output, or an explicit "cancelled", means cancelled.
      if (!err || CANCEL_HINTS.some((re) => re.test(message))) {
        resolve([]);
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
