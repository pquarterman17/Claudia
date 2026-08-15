import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertUsableDirectory, folderPickerCommand, normalizePath } from '../src/folder-picker.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-test-'));
const file = join(dir, 'a.txt');
writeFileSync(file, 'x');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('normalizePath', () => {
  it('strips the quotes Windows "Copy as path" adds', () => {
    expect(normalizePath('"C:\\Users\\me\\project"')).toBe('C:\\Users\\me\\project');
  });

  it('strips single quotes and surrounding whitespace', () => {
    expect(normalizePath("  '/home/me/project'  ", 'linux')).toBe('/home/me/project');
  });

  it('leaves an ordinary path alone, including inner spaces', () => {
    expect(normalizePath('C:\\Program Files\\thing')).toBe('C:\\Program Files\\thing');
  });

  it('does not strip a lone quote at one end', () => {
    expect(normalizePath('"weird')).toBe('"weird');
  });

  it('canonicalises separators on Windows so one folder is one entry', () => {
    // Both forms address the same directory; without this the recents list
    // accumulates a duplicate every time the other form is used.
    expect(normalizePath('C:/Users/me/project', 'win32')).toBe('C:\\Users\\me\\project');
    expect(normalizePath('C:\\Users\\me\\project', 'win32')).toBe('C:\\Users\\me\\project');
  });

  it('leaves POSIX separators alone', () => {
    expect(normalizePath('/home/me/project', 'linux')).toBe('/home/me/project');
  });

  it('drops a trailing separator but keeps a bare root', () => {
    expect(normalizePath('C:\\x\\', 'win32')).toBe('C:\\x');
    expect(normalizePath('/home/me/', 'linux')).toBe('/home/me');
    expect(normalizePath('C:\\', 'win32')).toBe('C:\\');
    expect(normalizePath('/', 'linux')).toBe('/');
  });
});

describe('assertUsableDirectory', () => {
  it('accepts a real directory', () => {
    expect(() => assertUsableDirectory(dir)).not.toThrow();
  });

  it('rejects empty input', () => {
    expect(() => assertUsableDirectory('')).toThrow(/required/i);
  });

  it('rejects a path that does not exist, naming it', () => {
    const missing = join(dir, 'nope');
    expect(() => assertUsableDirectory(missing)).toThrow(/No such directory/);
    expect(() => assertUsableDirectory(missing)).toThrow(missing);
  });

  it('rejects a file — launching into one would fail obscurely later', () => {
    expect(() => assertUsableDirectory(file)).toThrow(/Not a directory/);
  });
});

describe('macOS folder picker command', () => {
  it('uses osascript with multi-select and one POSIX path per line', () => {
    const command = folderPickerCommand('darwin');
    expect(command.file).toBe('osascript');
    expect(command.args.join('\n')).toContain('with multiple selections allowed');
    expect(command.args.join('\n')).toContain('POSIX path of d & linefeed');
  });

  it('embeds an initial folder into the AppleScript rather than treating it as a script file', () => {
    const command = folderPickerCommand('darwin', '/Users/pat/Projects/Claudia');
    expect(command.args).toContain(
      'set dirs to choose folder with prompt "Select working directories for Claudia" default location (POSIX file "/Users/pat/Projects/Claudia") with multiple selections allowed',
    );
    expect(command.args.at(-1)).not.toBe('/Users/pat/Projects/Claudia');
  });

  it('keeps POSIX paths and a bare root stable for macOS', () => {
    expect(normalizePath('/Users/pat/Project/', 'darwin')).toBe('/Users/pat/Project');
    expect(normalizePath('/', 'darwin')).toBe('/');
  });
});
