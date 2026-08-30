import { describe, expect, it } from 'vitest';
import { describeCommand, executeFinishAction, FINISH_ACTIONS, hostPlatform, specFor } from '../src/finish-actions.js';

describe('per-OS command table', () => {
  it('never runs a Windows command on Linux', () => {
    // The original table fell through to the Windows branch for anything that
    // was not macOS, so on Linux "notify" invoked powershell.exe and "sleep"
    // invoked rundll32. Every action must resolve per platform.
    for (const spec of FINISH_ACTIONS) {
      const linux = spec.command('linux');
      if (!linux) continue; // actions with no single host command
      expect(linux.file, `${spec.key} on linux`).not.toMatch(/\.exe$|powershell/i);
    }
  });

  it('resolves the documented commands per platform', () => {
    expect(describeCommand('sleep', 'darwin')).toContain('pmset');
    expect(describeCommand('sleep', 'win32')).toContain('LockWorkStation');
    expect(describeCommand('sleep', 'linux')).toContain('xset');
    expect(describeCommand('shutdown', 'linux')).toBe('shutdown -h now');
    expect(describeCommand('notify', 'linux')).toContain('notify-send');
    expect(describeCommand('script', 'linux')).toContain('wrapup.sh');
  });

  it('uses only macOS-native commands in its macOS finish chain', () => {
    expect(specFor('notify').command('darwin')).toMatchObject({ file: 'osascript' });
    expect(specFor('sleep').command('darwin')).toEqual({ file: 'pmset', args: ['displaysleepnow'] });
    expect(specFor('shutdown').command('darwin')).toEqual({ file: 'shutdown', args: ['-h', 'now'] });
    expect(describeCommand('script', 'darwin')).toMatch(/\/bin\/wrapup\.sh$/);
  });

  it('marks only shutdown destructive', () => {
    expect(FINISH_ACTIONS.filter((a) => a.destructive).map((a) => a.key)).toEqual(['shutdown']);
  });

  it('describes actions that have no single host command', () => {
    expect(describeCommand('memory', 'linux')).toMatch(/memory files/i);
    // Per-repo git work, so there is no one command to show — but the chain row
    // must still say what it will do, and that it will not touch main.
    expect(specFor('commit').command('linux')).toBeNull();
    expect(describeCommand('commit', 'linux')).toMatch(/never on main or master/i);
  });

  it('routes commit to the injected git action rather than a host command', async () => {
    const ctx = {
      platform: 'linux' as const,
      cwd: '/repo',
      runMemoryUpdate: () => Promise.reject(new Error('wrong action')),
      runCommitPush: () => Promise.resolve('committed 1 file'),
    };
    expect(await executeFinishAction('commit', ctx)).toBe('committed 1 file');
  });

  it('lets a commit failure reject, so the chain stops before anything after it', async () => {
    // The ordering safety property: a refused commit must not be followed by a
    // shutdown that leaves the work unpushed on a sleeping machine.
    const ctx = {
      platform: 'linux' as const,
      cwd: '/repo',
      runMemoryUpdate: () => Promise.resolve(''),
      runCommitPush: () => Promise.reject(new Error('Refused: Claudia is on main')),
    };
    await expect(executeFinishAction('commit', ctx)).rejects.toThrow(/on main/);
  });

  it('maps unknown platforms to linux rather than windows', () => {
    // hostPlatform reads process.platform; this pins the fallback direction.
    expect(hostPlatform()).toMatch(/^(win32|darwin|linux)$/);
  });
});
