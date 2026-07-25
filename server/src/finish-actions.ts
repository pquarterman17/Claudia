import type { FinishActionKey, HostPlatform } from '@claudia/shared';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** A command as an argv array — never a shell string, so nothing is interpolated. */
interface Command {
  file: string;
  args: string[];
}

export interface FinishActionSpec {
  key: FinishActionKey;
  label: string;
  destructive: boolean;
  /** Null where the action isn't a single host command (e.g. per-repo git work). */
  command: (platform: HostPlatform) => Command | null;
}

const NOTIFY_MAC = (body: string): Command => ({
  file: 'osascript',
  args: ['-e', `display notification "${body}" with title "Claudia"`],
});

const NOTIFY_WIN = (body: string): Command => ({
  file: 'powershell.exe',
  args: [
    '-NoProfile',
    '-Command',
    `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
      `$n=New-Object System.Windows.Forms.NotifyIcon;` +
      `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
      `$n.ShowBalloonTip(5000,'Claudia','${body}','Info');Start-Sleep -Seconds 6`,
  ],
});

export const FINISH_ACTIONS: FinishActionSpec[] = [
  {
    key: 'notify',
    label: 'Notify me',
    destructive: false,
    command: (p) => (p === 'darwin' ? NOTIFY_MAC('All sessions settled') : NOTIFY_WIN('All sessions settled')),
  },
  {
    key: 'commit',
    label: 'Commit + push all',
    destructive: false,
    command: () => null, // per-repo; handled by the caller, not one host command
  },
  {
    key: 'sleep',
    label: 'Sleep displays',
    destructive: false,
    command: (p) =>
      p === 'darwin'
        ? { file: 'pmset', args: ['displaysleepnow'] }
        : { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  },
  {
    key: 'shutdown',
    label: 'Shut down host',
    destructive: true,
    command: (p) =>
      p === 'darwin'
        ? { file: 'shutdown', args: ['-h', 'now'] }
        : { file: 'shutdown.exe', args: ['/s', '/t', '0'] },
  },
  {
    key: 'script',
    label: 'Run wrap-up script',
    destructive: false,
    command: (p) =>
      p === 'darwin'
        ? { file: `${homedir()}/bin/wrapup.sh`, args: [] }
        : { file: 'powershell.exe', args: ['-NoProfile', '-File', 'C:\\bin\\wrapup.ps1'] },
  },
];

export function specFor(key: FinishActionKey): FinishActionSpec {
  const spec = FINISH_ACTIONS.find((a) => a.key === key);
  if (!spec) throw new Error(`Unknown finish action: ${key}`);
  return spec;
}

export function hostPlatform(): HostPlatform {
  const p = process.platform;
  return p === 'darwin' || p === 'win32' ? p : 'linux';
}

/** Display string for the UI — what will actually run on this host. */
export function describeCommand(key: FinishActionKey, platform: HostPlatform): string {
  const cmd = specFor(key).command(platform);
  if (!cmd) return 'git push, per repository with commits ahead';
  return [cmd.file, ...cmd.args].join(' ');
}

export async function executeFinishAction(key: FinishActionKey, platform: HostPlatform): Promise<string> {
  const spec = specFor(key);
  const cmd = spec.command(platform);
  if (!cmd) return 'No host command for this action (not yet implemented)';
  await run(cmd.file, cmd.args, { timeout: 30_000 });
  return `Ran ${spec.label}`;
}
