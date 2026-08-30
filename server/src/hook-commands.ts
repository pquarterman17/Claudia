import { installHooks, uninstallHooks, type HookChange } from './hook-install.js';

export interface HookMonitorOutcome {
  /** Whether the monitor is on after this call — what the UI should now show. */
  monitoring: boolean;
  /** Plain-language account of what was written, or null when nothing was. */
  notice: string | null;
  error: string | null;
}

/**
 * Turns the global hook on or off and says exactly what changed on disk.
 *
 * The account is not decoration. The owner approved editing their global
 * `~/.claude/settings.json` on the condition that the change is reported back,
 * so the caller gets the real path, the events touched and where the previous
 * file was kept — not "done".
 */
export async function setHookMonitor(enabled: boolean, port: number): Promise<HookMonitorOutcome> {
  const change: HookChange = enabled ? await installHooks(port) : await uninstallHooks(port);
  if (!change.ok) {
    // Still report the monitor as off: a failed install did not install it,
    // and a UI that says otherwise is worse than one that says nothing.
    return { monitoring: false, notice: null, error: change.error ?? `Could not update ${change.path}` };
  }
  if (change.unchanged) return { monitoring: enabled, notice: null, error: null };

  const count = (change.events ?? []).length;
  const verb = enabled ? 'Added' : 'Removed';
  const backup = change.backupPath ? ` Your previous file is kept at ${change.backupPath}.` : '';
  return {
    monitoring: enabled,
    notice: `${verb} Claudia's hook for ${count} event${count === 1 ? '' : 's'} in ${change.path}.${backup}`,
    error: null,
  };
}
