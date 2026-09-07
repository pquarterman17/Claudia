import { statSync } from 'node:fs';
import type { WorktreeRecord } from '@claudia/shared';
import { gitLine, gitSays } from './git-facts.js';
import type { ObservedWorktree } from './worktree-owner.js';

/**
 * What is actually at a path, as far as this process can tell.
 *
 * Shared by the launcher, which reads a worktree before claiming it, and by
 * the reaper, which reads one before removing it. One observer because the two
 * decisions are graded against the same evidence: `claimWorktree` refuses on
 * every unknown and `cleanupWorktree` keeps on every unknown, and a second
 * implementation drifting by one field would break that symmetry in whichever
 * direction nobody was looking.
 *
 * Every field is left UNDEFINED when it cannot be read. That is the point:
 * `exists: false` is the one value that skips the identity, dirty and merged
 * vetoes, so a `statSync` that failed for any reason other than "nothing
 * there" must not be reported as an empty path.
 */
export async function observeWorktree(path: string): Promise<ObservedWorktree> {
  try {
    statSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { exists: false } : {};
  }
  const common = await gitLine(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const status = await gitLine(path, ['status', '--porcelain'], { allowEmpty: true });
  return {
    exists: true,
    ...(common ? { repo: common.replace(/[/\\]\.git\/?$/, '') } : {}),
    ...(await optional('branch', gitLine(path, ['rev-parse', '--abbrev-ref', 'HEAD']))),
    ...(await optional('headSha', gitLine(path, ['rev-parse', 'HEAD']))),
    ...(status === undefined ? {} : { dirty: status.length > 0 }),
  };
}

/**
 * The same observation, plus the one fact only the destructive path needs.
 *
 * `merged` is not gathered for a claim because a claim never asks it, and
 * every field here costs a `git` invocation on a pass that walks every record
 * a mission owns.
 */
export async function observeForCleanup(record: WorktreeRecord): Promise<ObservedWorktree> {
  const observed = await observeWorktree(record.path);
  if (observed.exists !== true) return observed;
  const merged = await mergedAway(record, observed);
  return merged === undefined ? observed : { ...observed, merged };
}

/**
 * Whether this branch's commits exist somewhere other than this worktree.
 *
 * Asked in the MAIN repository, not the worktree: the question is whether the
 * work survives the directory going away, and a worktree can always reach its
 * own commits. `undefined` is a real answer here and the common one — a repo
 * with no `git`, a detached head, a tip that was never fetched — and
 * `cleanupWorktree` keeps on it, which is the whole reason it is tri-state.
 *
 * A tip still at `baseSha` is merged by construction: the branch has no
 * commits of its own, so there is nothing to lose. That case is checked first
 * because it is both the cheapest and the one `--is-ancestor` is least likely
 * to be able to answer, a fresh worktree having nothing to compare against.
 */
async function mergedAway(record: WorktreeRecord, observed: ObservedWorktree): Promise<boolean | undefined> {
  const tip = observed.headSha;
  if (tip === undefined) return undefined;
  if (record.baseSha && tip === record.baseSha) return true;
  // Contained in the checkout the human is actually looking at. Deliberately
  // not `--merged <default branch>`: this repo does not record which branch a
  // worktree was meant to land on, and guessing `main` would answer "not
  // merged" for every fleet that uses anything else — the safe direction, but
  // one that would make the reaper permanently useless rather than cautious.
  return gitSays(record.repo, ['merge-base', '--is-ancestor', tip, 'HEAD']);
}

async function optional<K extends string>(key: K, value: Promise<string | undefined>): Promise<Record<K, string> | object> {
  const resolved = await value;
  return resolved ? ({ [key]: resolved } as Record<K, string>) : {};
}
