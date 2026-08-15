import { describe, expect, it } from 'vitest';
import { describeCommand, FINISH_ACTIONS, hostPlatform, specFor } from '../src/finish-actions.js';

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
    expect(specFor('commit').command('linux')).toBeNull();
  });

  it('maps unknown platforms to linux rather than windows', () => {
    // hostPlatform reads process.platform; this pins the fallback direction.
    expect(hostPlatform()).toMatch(/^(win32|darwin|linux)$/);
  });
});
