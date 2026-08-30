import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rankFileMatches, searchFiles } from '../src/file-search.js';

const root = mkdtempSync(join(tmpdir(), 'claudia-filesearch-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'some-dep'), { recursive: true });
mkdirSync(join(root, '.git', 'objects'), { recursive: true });
writeFileSync(join(root, 'SECURITY.md'), '');
writeFileSync(join(root, 'src', 'security-guard.ts'), '');
writeFileSync(join(root, 'node_modules', 'some-dep', 'security.js'), '');
writeFileSync(join(root, '.git', 'objects', 'security-pack'), '');

describe('searchFiles', () => {
  it('finds a matching file relative to cwd, forward-slashed', async () => {
    const matches = await searchFiles(root, 'SECURITY');
    expect(matches.map((m) => m.path)).toContain('SECURITY.md');
    // Never a backslash, even though this walk runs on Windows too.
    for (const m of matches) expect(m.path).not.toContain('\\');
  });

  it('never descends into node_modules', async () => {
    const matches = await searchFiles(root, 'security');
    expect(matches.some((m) => m.path.includes('node_modules'))).toBe(false);
  });

  it('never descends into .git', async () => {
    const matches = await searchFiles(root, 'security');
    expect(matches.some((m) => m.path.includes('.git'))).toBe(false);
  });

  it('returns nothing for an empty query rather than dumping the tree', async () => {
    expect(await searchFiles(root, '')).toEqual([]);
    expect(await searchFiles(root, '   ')).toEqual([]);
  });

  it('never rejects for a directory that does not exist', async () => {
    await expect(searchFiles(join(root, 'does-not-exist'), 'x')).resolves.toEqual([]);
  });

  // Building and deleting the fixture is far slower than searching it, and on a
  // Windows CI runner with a virus scanner in the path it alone overran the 5s
  // default timeout — the test failed at 10s while the code under test was
  // fine. Creation moves into beforeAll with a timeout of its own so the test
  // measures the search, not the filesystem.
  describe('on a large tree', () => {
    let big: string;
    // Deliberately above the 500-candidate cap inside searchFiles: at or below
    // it this fixture stops exercising the bound it exists to test, while every
    // assertion below still passes.
    const DIRS = 30;
    const FILES_PER_DIR = 20;

    beforeAll(() => {
      big = mkdtempSync(join(tmpdir(), 'claudia-filesearch-big-'));
      for (let d = 0; d < DIRS; d++) {
        const dir = join(big, `pkg-${d}`);
        mkdirSync(dir, { recursive: true });
        for (let f = 0; f < FILES_PER_DIR; f++) writeFileSync(join(dir, `widget-${f}.ts`), '');
      }
    }, 120_000);

    afterAll(() => rmSync(big, { recursive: true, force: true }));

    it('still has more files than the candidate cap it exists to exercise', () => {
      expect(DIRS * FILES_PER_DIR).toBeGreaterThan(500);
    });

    it('caps results no matter how many files match', async () => {
      // No wall-clock assertion: a hardcoded millisecond ceiling measures the
      // runner's load, not this code, and that is precisely how the previous
      // version became flaky. A walk that never returns is caught by the test
      // timeout instead, which scales with the machine rather than guessing.
      const matches = await searchFiles(big, 'widget');
      expect(matches.length).toBeLessThanOrEqual(20);
      expect(matches.length).toBeGreaterThan(0);
    }, 30_000);
  });
});

describe('rankFileMatches', () => {
  it('ranks a filename that starts with the query above one that merely contains it', () => {
    const ranked = rankFileMatches(['src/use-security.ts', 'src/security.ts'], 'security');
    expect(ranked[0]).toBe('src/security.ts');
  });

  it('ranks a filename match above a path-only match', () => {
    const ranked = rankFileMatches(['security/index.ts', 'src/security.ts'], 'security');
    expect(ranked).toEqual(['src/security.ts', 'security/index.ts']);
  });

  it('excludes paths that do not match at all', () => {
    expect(rankFileMatches(['src/unrelated.ts'], 'security')).toEqual([]);
  });

  it('is stable within a rank, preserving the caller order', () => {
    const ranked = rankFileMatches(['a/security-b.ts', 'a/security-a.ts'], 'security');
    expect(ranked).toEqual(['a/security-b.ts', 'a/security-a.ts']);
  });

  it('returns everything unchanged for an empty query', () => {
    expect(rankFileMatches(['b.ts', 'a.ts'], '')).toEqual(['b.ts', 'a.ts']);
  });
});
