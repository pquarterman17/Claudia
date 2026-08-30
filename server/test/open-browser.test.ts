import { describe, expect, it } from 'vitest';
import { openCommand, shouldOpenBrowser } from '../src/open-browser.js';

/**
 * Every platform driven from whichever one this runs on, exactly as the per-OS
 * finish-action table is tested — the launcher bug this replaced was Windows
 * only, so a test that can only see the host's own platform would not have
 * caught it and would not catch the next one.
 */

describe('openCommand', () => {
  it('reaches `start` through cmd on Windows, since it is not a binary', () => {
    expect(openCommand('http://127.0.0.1:4317', 'win32')).toEqual({
      file: 'cmd',
      args: ['/c', 'start', '', 'http://127.0.0.1:4317'],
    });
  });

  it('keeps the empty title argument that `start` requires', () => {
    // Not padding: `start` reads its first quoted argument as a window title,
    // so dropping it makes the URL the title and opens nothing at all.
    const { args } = openCommand('http://127.0.0.1:4317', 'win32');
    expect(args[2]).toBe('');
    expect(args[3]).toBe('http://127.0.0.1:4317');
  });

  it('uses the native opener on macOS and Linux', () => {
    expect(openCommand('http://127.0.0.1:4317', 'darwin')).toEqual({ file: 'open', args: ['http://127.0.0.1:4317'] });
    expect(openCommand('http://127.0.0.1:4317', 'linux')).toEqual({ file: 'xdg-open', args: ['http://127.0.0.1:4317'] });
  });

  it('never runs a Windows command on a POSIX platform', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(openCommand('http://127.0.0.1:4317', platform).file, platform).not.toMatch(/cmd|\.exe$/i);
    }
  });

  it('carries the port it was given, not a hard-coded one', () => {
    // CLAUDIA_PORT=0 means the real port is only known once bound, which is
    // the whole reason this moved into the listen callback.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(openCommand('http://127.0.0.1:53119', platform).args.join(' ')).toContain(':53119');
    }
  });

  it('never opens `localhost`, which is the address that broke', () => {
    // The server binds IPv4 only and Windows resolves localhost to ::1 first.
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(openCommand('http://127.0.0.1:4317', platform).args.join(' ')).not.toContain('localhost');
    }
  });

  it('passes the URL as its own argument, never interpolated into a string', () => {
    // argv, not a shell line: a URL is user-adjacent input and this runs on
    // three shells with three quoting rules.
    const { args } = openCommand('http://127.0.0.1:4317', 'win32');
    expect(args.filter((a) => a.includes('127.0.0.1'))).toHaveLength(1);
  });
});

describe('shouldOpenBrowser', () => {
  it('stays out of the way unless a launcher asked', () => {
    // `npm start` is also how a server is run from a terminal or over SSH.
    expect(shouldOpenBrowser({})).toBe(false);
    expect(shouldOpenBrowser({ CLAUDIA_OPEN: '' })).toBe(false);
    expect(shouldOpenBrowser({ CLAUDIA_OPEN: '0' })).toBe(false);
    expect(shouldOpenBrowser({ CLAUDIA_OPEN: 'no' })).toBe(false);
  });

  it('opens when a launcher sets the flag', () => {
    expect(shouldOpenBrowser({ CLAUDIA_OPEN: '1' })).toBe(true);
    expect(shouldOpenBrowser({ CLAUDIA_OPEN: 'true' })).toBe(true);
    expect(shouldOpenBrowser({ CLAUDIA_OPEN: 'TRUE' })).toBe(true);
  });
});
