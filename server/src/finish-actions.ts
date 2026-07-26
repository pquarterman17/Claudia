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
  /** Display text when there is no single command to show. */
  describe?: () => string;
}

const NOTIFY_MAC = (body: string): Command => ({
  file: 'osascript',
  args: ['-e', `display notification "${body}" with title "Claudia"`],
});

const NOTIFY_LINUX = (body: string): Command => ({
  file: 'notify-send',
  args: ['Claudia', body],
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
    command: (p) =>
      p === 'darwin'
        ? NOTIFY_MAC('All sessions settled')
        : p === 'linux'
          ? NOTIFY_LINUX('All sessions settled')
          : NOTIFY_WIN('All sessions settled'),
  },
  {
    key: 'memory',
    label: 'Save learnings',
    destructive: false,
    // Not a shell command — runs as an SDK session, since deciding what was
    // actually learned is judgement rather than a fixed operation.
    command: () => null,
    describe: () => 'Claude reviews the work and updates its memory files',
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
        : p === 'linux'
          ? { file: 'xset', args: ['dpms', 'force', 'off'] }
          : { file: 'rundll32.exe', args: ['user32.dll,LockWorkStation'] },
  },
  {
    key: 'shutdown',
    label: 'Shut down host',
    destructive: true,
    command: (p) =>
      p === 'darwin' || p === 'linux'
        ? { file: 'shutdown', args: ['-h', 'now'] }
        : { file: 'shutdown.exe', args: ['/s', '/t', '0'] },
  },
  {
    key: 'script',
    label: 'Run wrap-up script',
    destructive: false,
    command: (p) =>
      p === 'win32'
        ? { file: 'powershell.exe', args: ['-NoProfile', '-File', 'C:\\bin\\wrapup.ps1'] }
        : { file: `${homedir()}/bin/wrapup.sh`, args: [] },
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
  const spec = specFor(key);
  const cmd = spec.command(platform);
  if (cmd) return [cmd.file, ...cmd.args].join(' ');
  return spec.describe?.() ?? 'not implemented yet';
}

export interface ExecutionContext {
  platform: HostPlatform;
  /** Where non-command actions run — the most recently used working directory. */
  cwd: string;
  /** Injected so the SDK-backed action stays out of this module. */
  runMemoryUpdate: (cwd: string) => Promise<string>;
}

/**
 * Runs one action and resolves with a description of what happened.
 * Rejecting is meaningful: a chain stops at the first failure, so an action must
 * throw rather than return quietly when it did not do its job.
 */
export async function executeFinishAction(key: FinishActionKey, ctx: ExecutionContext): Promise<string> {
  const spec = specFor(key);

  if (key === 'memory') return ctx.runMemoryUpdate(ctx.cwd);

  const cmd = spec.command(ctx.platform);
  if (!cmd) throw new Error(`${spec.label} is not implemented yet`);

  // Long enough for a wrap-up script, short enough not to hang a chain forever.
  await run(cmd.file, cmd.args, { timeout: 120_000 });
  return `Ran ${spec.label}`;
}
