import type { HostPlatform } from '@claudia/shared';
import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';

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
  win32: {
    file: 'powershell.exe',
    // -STA: Windows Forms dialogs require a single-threaded apartment.
    args: [
      '-NoProfile',
      '-STA',
      '-Command',
      "Add-Type -AssemblyName System.Windows.Forms;" +
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog;" +
        "$d.Description = 'Select a working directory for Claudia';" +
        "$d.ShowNewFolderButton = $false;" +
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }",
    ],
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

/** Resolves to the chosen path, or null if the user cancelled. */
export function pickFolder(platform: HostPlatform): Promise<string | null> {
  const picker = PICKERS[platform];
  return new Promise((resolve, reject) => {
    execFile(picker.file, picker.args, { timeout: 180_000 }, (err, stdout) => {
      const chosen = stdout.trim();
      // Cancel exits non-zero on every platform; that is not an error to report.
      if (err && !chosen) return resolve(null);
      if (!chosen) return resolve(null);
      try {
        resolve(normalizePath(chosen));
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Cleans a path the user pasted. Windows "Copy as path" wraps it in quotes, and
 * dragged or copied paths often carry stray whitespace.
 */
export function normalizePath(raw: string): string {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).trim();
  }
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
