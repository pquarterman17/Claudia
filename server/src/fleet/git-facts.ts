import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Asking git a question that may have no answer.
 *
 * Shared by the launcher, which reads a worktree before claiming it, and by
 * the evidence gatherer, which reads one after a child says it is finished.
 * Both want the same thing: a fact if git can supply one, and `undefined`
 * rather than a throw if it cannot — because "this is not a repository", "this
 * commit does not exist" and "git is not installed" are all answers the caller
 * has to carry on from, not failures worth aborting a pulse over.
 *
 * Timeboxed, because a `git` that hangs on a network remote or a lock would
 * otherwise hold the fleet's post-commit pass open indefinitely.
 */
export async function gitLine(
  cwd: string,
  args: string[],
  opts: { allowEmpty?: boolean } = {},
): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000, windowsHide: true });
    const line = stdout.trim();
    return line || (opts.allowEmpty ? '' : undefined);
  } catch {
    return undefined;
  }
}

/** Whether git can answer yes to a question that exits 0 for yes and 1 for no. */
export async function gitSays(cwd: string, args: string[]): Promise<boolean | undefined> {
  try {
    await run('git', args, { cwd, timeout: 10_000, windowsHide: true });
    return true;
  } catch (err) {
    // Exit 1 is a real "no". Anything else — git missing, not a repository, a
    // bad revision — is not an answer at all, and saying `false` would let a
    // broken environment read as evidence of a fact.
    const code = (err as { code?: number | string }).code;
    return code === 1 ? false : undefined;
  }
}
