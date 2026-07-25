import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertUsableDirectory, normalizePath } from '../src/folder-picker.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-test-'));
const file = join(dir, 'a.txt');
writeFileSync(file, 'x');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('normalizePath', () => {
  it('strips the quotes Windows "Copy as path" adds', () => {
    expect(normalizePath('"C:\\Users\\me\\project"')).toBe('C:\\Users\\me\\project');
  });

  it('strips single quotes and surrounding whitespace', () => {
    expect(normalizePath("  '/home/me/project'  ")).toBe('/home/me/project');
  });

  it('leaves an ordinary path alone, including inner spaces', () => {
    expect(normalizePath('C:\\Program Files\\thing')).toBe('C:\\Program Files\\thing');
  });

  it('does not strip a lone quote at one end', () => {
    expect(normalizePath('"weird')).toBe('"weird');
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
