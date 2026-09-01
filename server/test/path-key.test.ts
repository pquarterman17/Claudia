import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worktreePathKey } from '../src/path-key.js';

/**
 * One directory, one key.
 *
 * Ownership is decided on this string and proved by a unique index over it, so
 * every way of writing the same directory must fold to the same key and every
 * way of writing a DIFFERENT one must not. Getting the first wrong lets one
 * directory take two live claims; getting the second wrong merges two
 * directories into a single claim, which is the worse half: two missions
 * writing to one checkout, believing they each own it.
 *
 * These cases are mostly a record of the hand-rolled version being wrong. It
 * is written against `node:path` now, which is why the cases below are asserted
 * against `path.win32` rather than against a table of expected strings wherever
 * the platform is the thing being trusted.
 */

describe('the path key is linear in its input', () => {
  it('does not degrade on a path that is mostly separators', () => {
    // CodeQL flagged the previous `replace(/(.)\/+$/, '$1')` as polynomial:
    // anchoring at `$` makes the engine retry from every starting offset, so a
    // path of many slashes cost O(n²) — and the input is a path out of a record
    // or a request, which is the "uncontrolled data" the alert means.
    const timeFor = (n: number): number => {
      const hostile = `a${'/'.repeat(n)}`;
      const started = performance.now();
      expect(worktreePathKey(hostile, 'posix')).toBe('a');
      return performance.now() - started;
    };
    timeFor(10_000);
    const elapsed = timeFor(200_000);
    expect(elapsed, `20x the input took ${elapsed.toFixed(0)}ms`).toBeLessThan(50);
  });

  it.each([
    ['/', 'posix', '/'],
    ['//', 'posix', '/'],
    ['/a//', 'posix', '/a'],
    ['/a/b', 'posix', '/a/b'],
    ['C:/', 'win32', 'c:/'],
    ['C:', 'win32', 'c:.'],
    ['C:\\Repo\\Work\\', 'win32', 'c:/repo/work'],
  ] as const)('still answers %s the same way it did', (input, platform, expected) => {
    // The scan replaced a regex, so every boundary it used to get right has to
    // survive: `/` stays `/` rather than reducing to the empty string and
    // making an unwritten path equal the filesystem root.
    expect(worktreePathKey(input, platform)).toBe(expected);
  });
});

describe('the key names a directory, not a spelling of one', () => {
  it.each([
    ['/repo//work', '/repo/work', 'posix'],
    ['/repo/./work', '/repo/work', 'posix'],
    ['/repo/work/../work', '/repo/work', 'posix'],
    ['/repo/work/', '/repo/work', 'posix'],
    ['C:/repo//work', 'C:\\repo\\work', 'win32'],
    ['C:\\repo\\.\\work', 'C:/repo/work', 'win32'],
    ['C:/repo/work/../work', 'C:/repo/work', 'win32'],
  ] as const)('gives %s and %s one key', (a, b, platform) => {
    // Found in review: repeated separators and . / .. left the same directory
    // with two different keys, so it could still take two live claims — which
    // is the whole thing the key exists to prevent.
    expect(worktreePathKey(a, platform)).toBe(worktreePathKey(b, platform));
  });

  it.each([
    ['C:/', 'C:', 'win32'],
    ['/a/b', '/a', 'posix'],
    ['../a', 'a', 'posix'],
    ['//server/share/a', '/server/share/a', 'win32'],
  ] as const)('keeps %s and %s apart', (a, b, platform) => {
    // The parts that say WHERE a path starts from survive folding: a drive root
    // is not drive-relative, and a UNC share is not two redundant separators.
    expect(worktreePathKey(a, platform)).not.toBe(worktreePathKey(b, platform));
  });

  it('clamps .. at an absolute root but keeps it in a relative path', () => {
    expect(worktreePathKey('/a/../..', 'posix')).toBe('/');
    expect(worktreePathKey('a/../..', 'posix')).toBe('..');
  });
});

describe('the four cases that sent this to node:path', () => {
  it.each([
    ['C:../foo', 'C:foo'],
    ['C:/', 'C:'],
    ['C:/repo', 'C:repo'],
  ] as const)('keeps the drive-relative %s away from %s', (a, b) => {
    // `C:foo` is "foo, wherever this process happens to be on drive C"; `C:/foo`
    // is a fixed directory. The hand-rolled version turned the first into the
    // second, which merges a path that means different things at different
    // moments into the key of one real directory.
    expect(worktreePathKey(a, 'win32')).not.toBe(worktreePathKey(b, 'win32'));
  });

  it('cannot pop a UNC share out of its own root', () => {
    // `\\server\share` is the root, not two directories: `..` from inside it
    // stays inside it. Folding it to `/server/share` and then popping `share`
    // produced `//server/other`, a key for a share this path can never reach.
    expect(worktreePathKey('//server/share/../other', 'win32')).toBe(
      worktreePathKey('//server/share/other', 'win32'),
    );
    expect(worktreePathKey('//server/share/../other', 'win32')).not.toBe(
      worktreePathKey('//server/other', 'win32'),
    );
  });

  it('folds a doubled separator after a drive', () => {
    expect(worktreePathKey('C://repo', 'win32')).toBe(worktreePathKey('C:/repo', 'win32'));
  });

  it('reads a colon as an ordinary character on posix', () => {
    // `a:` is a legal filename on POSIX. Treating it as a drive made `a:../b`
    // absolute on a platform that has no drives at all.
    expect(worktreePathKey('a:../b', 'posix')).toBe('a:../b');
    expect(worktreePathKey('a:../b', 'posix')).not.toBe(worktreePathKey('a:/b', 'posix'));
  });
});

describe('properties, rather than a second table of expected strings', () => {
  const inputs = [
    'C:/repo/work',
    'C:repo',
    'C:../repo',
    'C:',
    'C:/',
    '//server/share',
    '//server/share/a/../b',
    '/repo//work/',
    'repo/../work',
    '../..',
    'a:/b',
  ] as const;

  it.each(inputs)('is idempotent for %s', (input) => {
    // The key is written to a column and read back for comparison, so a key
    // that is not itself a canonical path would compare unequal to a fresh
    // canonicalisation of the same directory.
    for (const platform of ['win32', 'posix'] as const) {
      const once = worktreePathKey(input, platform);
      expect(worktreePathKey(once, platform)).toBe(once);
    }
  });

  it.each(inputs)('does not change what %s is anchored to', (input) => {
    // The single property every one of the four bugs above violated: folding
    // the spelling must not move a path between "fixed directory" and "wherever
    // this process happens to be". Asserted against `path.win32` itself, so the
    // test cannot inherit the same misunderstanding as the code.
    expect(win32.isAbsolute(worktreePathKey(input, 'win32'))).toBe(win32.isAbsolute(input));
  });
});
