import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { commandWords, verifyCommandProblem } from '@claudia/shared';
import { runnable, runVerify } from '../src/fleet/verify.js';

/**
 * Running a mission's checks, and refusing the ones that cannot be run.
 *
 * The distinction everything here turns on: a command that FAILED and a
 * command that could not be RUN are different answers. The first is evidence
 * the work is bad; the second is evidence of nothing, and reporting it as a
 * failure would reject good work because a binary was missing.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-verify-'));
afterAll(() => {
  // Tolerated, uniquely in this suite, and said out loud when it happens.
  //
  // This is the one suite that writes executables and runs them, and on the
  // Windows runner that directory would not go away: EBUSY first, then EPERM
  // through three seconds of retries. Removing a temp directory is not what
  // any of these tests assert, the runner reaps it either way, and a suite in
  // which all 1,665 tests pass should not be reported as failing because a
  // virus scanner still had a `.cmd` file open. The warning is there so a real
  // handle leak is still visible rather than silently normal.
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch (err) {
    console.warn(`[test] could not remove ${dir}:`, err);
  }
});

const WINDOWS = process.platform === 'win32';

/**
 * A real script, because the point is what a real process does.
 *
 * Both dialects, written out rather than assumed. `sleep` and `ls` do not
 * exist on the Windows runner and `exit` there ends the shell rather than the
 * script, so a fixture written in one dialect is a test that only runs on one
 * platform — which is exactly the fault the evidence suite's `mkdir -p` was.
 */
function script(name: string, body: { posix: string; windows: string }): string {
  const path = join(dir, WINDOWS ? `${name}.cmd` : `${name}.sh`);
  writeFileSync(path, WINDOWS ? `@echo off\r\n${body.windows}\r\n` : `#!/bin/sh\n${body.posix}\n`, 'utf8');
  if (!WINDOWS) chmodSync(path, 0o755);
  // Quoted, so a temp path with a space in it survives the shell that runs it.
  return `"${path}"`;
}

describe('reading a command', () => {
  it('splits on whitespace and keeps quoted words whole', () => {
    expect(commandWords('npm test')).toEqual(['npm', 'test']);
    expect(commandWords('  npm   run   check  ')).toEqual(['npm', 'run', 'check']);
    expect(commandWords('"/opt/my tools/check" --fast')).toEqual(['/opt/my tools/check', '--fast']);
    expect(commandWords("echo 'two words'")).toEqual(['echo', 'two words']);
    // A quote starts a word even around nothing, so an empty argument survives.
    expect(commandWords('check ""')).toEqual(['check', '']);
  });

  it('is not a command when it has nothing in it, or a quote left open', () => {
    expect(commandWords('')).toBeUndefined();
    expect(commandWords('   ')).toBeUndefined();
    // Guessing where the quote was meant to close would run something subtly
    // different from what was written.
    expect(commandWords('npm run "check')).toBeUndefined();
  });
});

describe('refusing a command that cannot mean what it says', () => {
  it('takes one program with arguments', () => {
    expect(verifyCommandProblem('npm test')).toBeUndefined();
    expect(verifyCommandProblem('./scripts/check.sh --ci')).toBeUndefined();
    // Clearing it is how a mission stops being checked.
    expect(verifyCommandProblem('')).toBeUndefined();
  });

  it('refuses shell operators rather than passing them as arguments', () => {
    // The failure this prevents is silent and permanent: parsed as arguments,
    // npm gets four words it does not understand, exits non-zero, and every
    // finished child is rejected for the rest of the mission's life.
    for (const command of ['npm test && npm run lint', 'a; b', 'a | b', 'echo `id`', 'a > out', 'a $(b)']) {
      expect(verifyCommandProblem(command), command).toMatch(/one program/);
    }
  });

  it('refuses an unbalanced quote', () => {
    expect(verifyCommandProblem('npm run "check')).toMatch(/quotes balanced/);
  });
});

describe('deciding whether there was anything to run', () => {
  // The classification the Windows runner needs and POSIX never reaches: there
  // a missing program is exit 127 and this is never consulted, so asking it
  // directly is the only way it is held to its job on the platform it exists
  // for.
  it('finds a program on the PATH by its bare name', () => {
    expect(runnable(dir, 'node')).toBe(true);
    // With arguments, because it is the command that is stored, not the word.
    expect(runnable(dir, 'node --version')).toBe(true);
  });

  it('resolves a relative program against the worktree, not the server', () => {
    const where = mkdtempSync(join(dir, 'rel-'));
    writeFileSync(join(where, 'check.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    expect(runnable(where, './check.sh')).toBe(true);
    // The same command from a different directory is a different answer, which
    // is the whole reason the worktree is passed in.
    expect(runnable(dir, './check.sh')).toBe(false);
  });

  it('says no to something that is not there, and to nothing at all', () => {
    expect(runnable(dir, join(dir, 'no-such-program'))).toBe(false);
    expect(runnable(dir, 'definitely-not-a-real-program-xyzzy')).toBe(false);
    expect(runnable(dir, '   ')).toBe(false);
  });
});

describe('running it', () => {
  it('reports the exit code of a command that passed', async () => {
    const outcome = await runVerify(dir, script('green', { posix: 'exit 0', windows: 'exit /b 0' }));
    expect(outcome.kind).toBe('checked');
    if (outcome.kind !== 'checked') throw new Error('unreachable');
    expect(outcome.result.exitCode).toBe(0);
    expect(outcome.note).toMatch(/exit 0$/);
  });

  it('reports the exit code of a command that failed, with the tail of its output', async () => {
    // The TAIL, not the head: a runner puts its failures at the end, and a
    // summary that is the same whether it passed or failed says nothing.
    const outcome = await runVerify(
      dir,
      script('red', { posix: 'echo the thing that broke\nexit 3', windows: 'echo the thing that broke\r\nexit /b 3' }),
    );
    if (outcome.kind !== 'checked') throw new Error(outcome.note);
    expect(outcome.result.exitCode).toBe(3);
    expect(outcome.result.summary).toContain('the thing that broke');
  });

  it('runs in the worktree it was given', async () => {
    // The whole point is that it checks the child's work rather than whatever
    // directory the server happens to be in.
    const where = mkdtempSync(join(dir, 'elsewhere-'));
    writeFileSync(join(where, 'marker.txt'), 'here', 'utf8');
    const outcome = await runVerify(
      where,
      script('marker', { posix: 'ls marker.txt', windows: 'dir /b marker.txt' }),
    );
    if (outcome.kind !== 'checked') throw new Error(outcome.note);
    expect(outcome.result.exitCode).toBe(0);
  });

  it('says a command that does not exist could not run, rather than that it failed', async () => {
    // The trap this closes, and the price of running through a shell: a
    // missing binary does not fail to spawn any more, it comes back as an
    // ordinary non-zero exit — so a typo in the command would reject every
    // finished child for the rest of the mission's life. The shell says which
    // it was: 127 on POSIX, 9009 from cmd.exe.
    const outcome = await runVerify(dir, join(dir, 'no-such-program-here'));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.note).toMatch(/could not run/);
  });

  it('tells a missing program from a failing one, whatever the shell answers', async () => {
    // The Windows runner is what proved this necessary: cmd.exe answers a
    // path that is not there with a plain exit 1, which is also what every
    // failing test suite returns. Exit codes alone would have read a typo as a
    // permanent reject on that platform — so the program is looked for.
    const absent = await runVerify(dir, join(dir, 'nope', 'not-a-program'));
    expect(absent.kind).toBe('unavailable');

    // And the other direction, which is what the check must not break: a real
    // program that really failed is a real failure.
    const failed = await runVerify(dir, script('genuine', { posix: 'exit 1', windows: 'exit /b 1' }));
    expect(failed.kind).toBe('checked');
    if (failed.kind !== 'checked') throw new Error('unreachable');
    expect(failed.result.exitCode).toBe(1);
  });

  it('says a command that never finished could not run either', async () => {
    // A suite that hangs is not evidence the work is bad. It is also the case
    // that bounds the pulse: the tick is sequential, so this timeout is what
    // stops one mission's checks stalling every other mission's.
    const outcome = await runVerify(
      dir,
      // A plain sleep, not a script: `exec` runs `sh -c`, which starts the
      // script in a shell of its OWN, so the kill reaches the wrapper and the
      // script's shell carries on — a busy loop written here to avoid an
      // orphan produced four of them, spinning at 100% and outliving the run.
      // What survives the kill is this one bounded second of `sleep`, which
      // the clean-up's retries are sized for. `ping -n 2` is its Windows twin.
      WINDOWS ? 'ping -n 2 127.0.0.1' : 'sleep 1',
      200,
    );
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.note).toMatch(/did not finish/);
  });

  it('refuses to run something that is not a command at all', async () => {
    const outcome = await runVerify(dir, '   ');
    expect(outcome.kind).toBe('unavailable');
  });

  it('refuses a command it would never have been allowed to store', async () => {
    // The runner enforces the same rule as the store, so the boundary holds
    // for any caller rather than only for the one that writes the column. The
    // proof is that nothing ran: the second half of this line would have
    // created the file.
    const proof = join(dir, 'must-not-exist.txt');
    const outcome = await runVerify(dir, `${script('noop', { posix: 'exit 0', windows: 'exit /b 0' })} && echo hi > ${proof}`);
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') throw new Error('unreachable');
    expect(outcome.note).toMatch(/one program/);
    expect(existsSync(proof)).toBe(false);
  });
});
