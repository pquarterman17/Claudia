import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { verifyCommandProblem } from '@claudia/shared';
import type { TestResult } from './acceptance.js';

const run = promisify(exec);

/**
 * Running a mission's checks over a finished child's worktree.
 *
 * The gap this closes is the last one in `acceptance.ts`, which has judged
 * evidence since the first fleet PR: nothing ever wrote `evidence.tests`, so
 * `missingEvidence` reported "test results" every time, `judge`'s
 * reject-on-failing-checks branch could not be reached by any input, and every
 * verdict the fleet has ever recorded was `needs_human`. The fleet could see a
 * diff; it could not tell whether the diff was any good.
 *
 * Through a shell, and the refusal is what makes that safe rather than the
 * spawn. Going without one was the first design and it does not survive
 * contact with Windows: `npm` there is `npm.cmd`, and node refuses to spawn a
 * `.cmd` without a shell at all — so the single commonest check anybody would
 * write could never have run on the platform this app is developed on. What
 * keeps this to ONE command is `verifyCommandProblem`, which refuses every
 * character a shell would read as more than arguments — `&`, `|`, `;`,
 * backticks, `$(`, redirection, a newline — at the store, where the command is
 * written, and again here so the boundary holds for any caller.
 *
 * Failure to RUN is not failure to pass. A missing binary, a directory that
 * vanished, a suite that hangs: none of those are evidence that the work is
 * bad, and returning a non-zero exit code for them would reject good work
 * because of a broken environment. They answer `unavailable`, which leaves the
 * evidence without test results — the same "nobody checked" the fleet had
 * before, reported honestly.
 */

/**
 * Two minutes, and the fleet's tick is SEQUENTIAL: `FleetPulser.tick` awaits
 * each mission in turn, so a verify that runs long delays the pulse of every
 * mission behind it by up to this much. That is the price of judging work at
 * all, and it is bounded and paid once per run — `judgeReported` skips a run it
 * has already judged, so a suite is never run twice for one attempt.
 *
 * A named constant rather than a magic number because it is the first thing to
 * lift into `FleetPolicy` if a real repository's checks turn out not to fit.
 *
 * The kill reaches the shell, not its descendants: a runner that has already
 * forked workers can leave them behind when this expires. Known and not
 * handled here — process-group teardown is a different piece of work, and the
 * honest report is that the check produced no verdict either way.
 */
export const VERIFY_TIMEOUT_MS = 120_000;

/** Enough output to recognise the failure by, not enough to fill the log. */
const SUMMARY_CHARS = 300;

/**
 * Exit codes that mean the shell never ran anything.
 *
 * The cost of running through a shell: a missing binary no longer fails to
 * spawn, it comes back as a perfectly ordinary non-zero exit — and a typo in
 * the command would then REJECT every finished child for the rest of the
 * mission's life, which is the failure the whole design is arranged against.
 *
 * 127 is POSIX's "command not found" and 126 its "found but not executable";
 * 9009 is what cmd.exe answers for a command it cannot find. A real suite that
 * chose one of these as its own failure code would be read as unchecked rather
 * than as failed — `needs_human` instead of `reject`, which is the direction
 * to be wrong in.
 */
const NEVER_RAN = new Set([126, 127, 9009]);

export type VerifyOutcome =
  /** The command ran and exited. `result.exitCode` is the verdict. */
  | { kind: 'checked'; result: TestResult; note: string }
  /** It could not be run, or did not finish. Not evidence either way. */
  | { kind: 'unavailable'; note: string };

export async function runVerify(
  cwd: string,
  command: string,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<VerifyOutcome> {
  // Checked here as well as at the store. The store is what stops a bad
  // command being written; this is what stops one running, and a rule enforced
  // in only one of those places is a rule the next caller does not have.
  const problem = verifyCommandProblem(command) ?? (command.trim() === '' ? 'there is no command to run' : undefined);
  if (problem !== undefined) return { kind: 'unavailable', note: `${command.trim() || '(nothing)'} — ${problem}` };

  try {
    const { stdout, stderr } = await run(command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      // Bounded, so a chatty suite cannot hold its whole output in the pulse's
      // memory. Overflow kills the child, and that is reported below as a run
      // that produced no verdict rather than as a failure.
      maxBuffer: 1_000_000,
    });
    return checked(command, 0, summarise(stdout, stderr));
  } catch (err) {
    const failure = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string | null;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code === 'string' && failure.code.includes('MAXBUFFER')) {
      return { kind: 'unavailable', note: `${command} — produced too much output to read` };
    }
    // Killed by us or by a signal: it never reached a verdict of its own.
    if (failure.killed === true || (failure.signal !== undefined && failure.signal !== null)) {
      return { kind: 'unavailable', note: `${command} — did not finish within ${Math.round(timeoutMs / 1000)}s` };
    }
    // A numeric code IS the program's answer, unless it is one of the codes a
    // shell uses to say it could not find a program to ask.
    if (typeof failure.code === 'number') {
      return NEVER_RAN.has(failure.code)
        ? { kind: 'unavailable', note: `${command} — could not run: nothing to execute (exit ${failure.code})` }
        : checked(command, failure.code, summarise(failure.stdout, failure.stderr));
    }
    return { kind: 'unavailable', note: `${command} — could not run: ${String(failure.code ?? 'unknown error')}` };
  }
}

function checked(command: string, exitCode: number, summary: string): VerifyOutcome {
  return {
    kind: 'checked',
    result: { command, exitCode, ...(summary ? { summary } : {}) },
    note: `${command} — exit ${exitCode}`,
  };
}

/**
 * The last of the output rather than the first.
 *
 * A test runner puts its failures at the end; the beginning is the banner every
 * run shares, and a summary that is the same whether it passed or failed tells
 * the person reading the decision nothing.
 */
function summarise(stdout: string | undefined, stderr: string | undefined): string {
  const text = `${stdout ?? ''}${stderr ?? ''}`.trim();
  return text.length <= SUMMARY_CHARS ? text : `…${text.slice(-SUMMARY_CHARS)}`;
}
