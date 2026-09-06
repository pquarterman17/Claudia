import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Tests that can only run on one platform, caught here rather than on a runner.
 *
 * Written after three rounds of Windows failures in one week, none of which
 * were about the code under test: a fixture that shelled out to `mkdir -p`
 * (that command does not exist there), `ls` and `sleep` inside scripts a test
 * wrote and ran, and a `.sh` file with a shebang. Every one passed
 * locally, went through review, and failed only on a runner — which is the
 * slowest possible place to learn it, and the one where the failure looks like
 * a product bug until you read the log.
 *
 * The rules are narrow on purpose. They do not try to prove a test is
 * portable; they catch the two shapes that have actually gone wrong here.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const SUITES = ['server/test', 'web/test'];

function collect(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // workspace not created yet
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
}

const files = SUITES.flatMap((suite) => {
  const found: string[] = [];
  collect(join(ROOT, suite), found);
  return found;
  // This file is not exempt, and it caught itself on the first run: the doc
  // above quoted the offending call verbatim, so the rule read its own
  // example as a violation. Worth keeping in mind before exempting anything —
  // it was right, and the fix was to describe the call rather than spell it.
});

/**
 * What a test may start a process for.
 *
 * An allowlist rather than a list of things to avoid: the failure mode is a
 * command nobody thought about, so the question has to be "is this one of the
 * few we know exist everywhere" and not "is this one of the ones we remembered
 * to ban". `git` and `node` are on every runner this repo builds on; anything
 * else — a directory to make, a file to copy, a mode to change — has a
 * `node:fs` call that works on all of them.
 */
const MAY_SPAWN = new Set(['git', 'node', 'npm', 'npx']);
// Not preceded by a dot: `db.exec('SELECT ...')` is SQLite, not a process, and
// the first version of this rule failed five suites for it.
const SPAWNS = /(?<![.\w])(?:execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*'([^']+)'/g;

/**
 * Commands that do not exist on Windows, as a test might write them into a
 * string it hands to the code under test — where the spawn rule cannot see
 * them. A file that RUNS things and mentions one has to know which platform it
 * is on.
 *
 * Scoped to files that run processes, because the first version of this rule
 * failed a dozen suites that merely talk about commands: a permission test
 * whose fixture is `Bash(rm:*)` is describing a rule, not running `rm`, and a
 * guard that cannot tell those apart teaches people to ignore it.
 */
const POSIX_ONLY = ['sleep', 'ls', 'rm', 'cp', 'mv', 'mkdir', 'cat', 'touch', 'chmod', 'grep', 'sed', 'awk', 'which'];
const POSIX_LITERAL = new RegExp(`'(?:${POSIX_ONLY.join('|')})(?: [^']*)?'`);
const PLATFORM_AWARE = /process\.platform|WINDOWS|win32/;
const RUNS_PROCESSES = /node:child_process|runVerify/;

describe('tests that have to run on every platform', () => {
  it('finds the test files', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((f) => [relative(ROOT, f).replaceAll('\\', '/'), f]))(
    '%s starts only processes that exist everywhere',
    (rel, full) => {
      const source = readFileSync(full, 'utf8');
      const started = [...source.matchAll(SPAWNS)].map((m) => m[1] as string);
      const foreign = started.filter((program) => !MAY_SPAWN.has(program));
      expect(
        foreign,
        `${rel} starts ${foreign.join(', ')}. Use node:fs, or a program every runner has — ` +
          'a fixture that can only set itself up on Linux is a test that only runs on Linux.',
      ).toEqual([]);
    },
  );

  it.each(files.map((f) => [relative(ROOT, f).replaceAll('\\', '/'), f]))(
    '%s knows which platform it is on before naming a POSIX command',
    (rel, full) => {
      const source = readFileSync(full, 'utf8');
      const names = RUNS_PROCESSES.test(source) && POSIX_LITERAL.test(source);
      expect(
        !names || PLATFORM_AWARE.test(source),
        `${rel} has a POSIX-only command in a string and never checks the platform. ` +
          'Windows has no `ls` or `sleep`; write both dialects, as fleet-evidence and ' +
          'verify-command do.',
      ).toBe(true);
    },
  );
});
