import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Evidence } from './acceptance.js';

const run = promisify(execFile);

/**
 * What the forge says about the branch a child worked on.
 *
 * `prUrl` and `prState` have been declared, judged on and written by nothing
 * since the first fleet PR: `judge` rejects a run whose pull request was
 * closed, and nothing had ever told it about a pull request. `blocksCleanup`
 * reads `prState === 'merged'` as one of the two ways to confirm a branch is
 * merged, and only ever saw the other one.
 *
 * Through `gh`, because there is no other way to learn it: git knows about
 * branches and commits, and a pull request is a fact about a website. That
 * makes this the one piece of evidence with a soft dependency, so it is built
 * to be absent: no `gh` on the PATH, no authentication, no PR for the branch,
 * or a call that times out all answer the same way — nothing, which reads as
 * "nobody checked" rather than as a claim.
 *
 * Never inferred. A branch with no pull request is not a CLOSED one, and
 * saying so would reject work whose author simply had not opened it yet.
 */
export async function pullRequestFor(cwd: string, branch: string): Promise<Pick<Evidence, 'prUrl' | 'prState'>> {
  if (!branch) return {};
  let stdout: string;
  try {
    const result = await run('gh', ['pr', 'view', branch, '--json', 'url,state,isDraft'], {
      cwd,
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 100_000,
    });
    stdout = result.stdout;
  } catch {
    // `gh` missing, unauthenticated, offline, or simply no pull request for
    // this branch — none of which is a fact about the work.
    return {};
  }

  return prFactsFrom(stdout);
}

/**
 * The answer, read out of what `gh` printed.
 *
 * Separate and exported because it is the half worth testing everywhere: the
 * I/O above needs a `gh` on the PATH, and node will not spawn a `.cmd` without
 * a shell — so a fake one could only be exercised on POSIX, and a mapping
 * tested on one platform is a mapping tested nowhere in particular.
 */
export function prFactsFrom(stdout: string): Pick<Evidence, 'prUrl' | 'prState'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;

  const url = record['url'];
  const state = stateOf(record['state'], record['isDraft']);
  return {
    ...(typeof url === 'string' && url !== '' ? { prUrl: url } : {}),
    ...(state !== undefined ? { prState: state } : {}),
  };
}

/**
 * `gh`'s words for the state, in ours.
 *
 * A state it does not recognise is left ABSENT rather than guessed at: the
 * four values `Evidence` allows are the ones `judge` and `blocksCleanup`
 * reason about, and a fifth arriving as one of them would be a decision made
 * on a misunderstanding.
 */
function stateOf(state: unknown, isDraft: unknown): Evidence['prState'] {
  if (typeof state !== 'string') return undefined;
  switch (state.toUpperCase()) {
    case 'MERGED':
      return 'merged';
    case 'CLOSED':
      return 'closed';
    case 'OPEN':
      return isDraft === true ? 'draft' : 'open';
    default:
      return undefined;
  }
}
