import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

  it('caps results at 20 and returns within its time budget on a large tree', async () => {
    const big = mkdtempSync(join(tmpdir(), 'claudia-filesearch-big-'));
    try {
      // Deep and wide enough that an unbounded walk would visibly hang: 40
      // sibling directories, 30 files apiece, all matching the query.
      for (let d = 0; d < 40; d++) {
        const dir = join(big, `pkg-${d}`);
        mkdirSync(dir, { recursive: true });
        for (let f = 0; f < 30; f++) writeFileSync(join(dir, `widget-${f}.ts`), '');
      }
      const started = Date.now();
      const matches = await searchFiles(big, 'widget');
      const elapsed = Date.now() - started;
      expect(matches.length).toBeLessThanOrEqual(20);
      // Generous ceiling above the 200ms internal budget — this asserts the
      // bound holds, not a tight performance target.
      expect(elapsed).toBeLessThan(2000);
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
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
