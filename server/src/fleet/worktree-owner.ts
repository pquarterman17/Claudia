import type { WorktreeRecord } from '@claudia/shared';

/**
 * Whether a run may take a worktree, and whether one may be thrown away.
 *
 * `worktree.ts` reuses any directory that happens to exist at the expected
 * path. For a human clicking "launch on a branch" that is a kindness — you
 * land back in the work you left. For an unattended fleet it is a hazard: the
 * directory may be a previous mission's, or a person's, and the existing code
 * cannot tell. The plan's rule is that no run claims or deletes an unverified
 * worktree, and this is where "verified" is defined.
 *
 * Pure, and separate from the git calls, because every interesting case here
 * is a combination of record and reality that is tedious to stage for real:
 * a record with no directory, a directory with no record, a directory on the
 * wrong branch, a clean tree owned by somebody else. Those are the cases that
 * lose work, and they need to be cheap to test.
 */

/** What git actually says about a path, as opposed to what the fleet believes. */
export interface ObservedWorktree {
  exists: boolean;
  /** Main repository this path is a worktree of, when it is one at all. */
  repo?: string;
  branch?: string;
  headSha?: string;
  /** Uncommitted changes present. Blocks every destructive path. */
  dirty?: boolean;
  /** Whether the branch's commits are already contained in the base branch. */
  merged?: boolean;
}

export interface ClaimRequest {
  repo: string;
  path: string;
  branch: string;
  missionId: string;
  taskId: string;
}

export type ClaimVerdict =
  | { kind: 'create'; reason: string }
  | { kind: 'reuse'; reason: string }
  | { kind: 'refuse'; reason: string };

/**
 * Decides how a task may acquire the worktree it asked for.
 *
 * Biased towards refusing. A wrong `create` costs a directory; a wrong `reuse`
 * drops somebody's uncommitted work into another agent's edit stream, and
 * nothing afterwards can tell you that is what happened.
 */
export function claimWorktree(
  request: ClaimRequest,
  record: WorktreeRecord | undefined,
  observed: ObservedWorktree,
): ClaimVerdict {
  if (!record) {
    if (!observed.exists) return { kind: 'create', reason: 'no worktree here yet' };
    // The ambiguous case the plan calls out by name. Something is there and
    // the fleet did not put it there, so it belongs to a human or to a run
    // whose record was lost; either way it is not ours to write into.
    return {
      kind: 'refuse',
      reason: `a directory already exists at ${request.path} and the fleet has no record of it`,
    };
  }

  if (record.state === 'removed' || record.state === 'archived') {
    if (observed.exists) {
      return { kind: 'refuse', reason: `the record says ${record.state} but the directory is still there` };
    }
    return { kind: 'create', reason: `re-creating a worktree that was ${record.state}` };
  }

  if (!observed.exists) {
    // Nothing can be lost by rebuilding: the directory is gone, and the branch
    // (with any commits on it) survives independently.
    return { kind: 'create', reason: 'the recorded worktree is missing from disk' };
  }

  // Everything below decides whether to WRITE into a directory that already
  // has work in it, so every check fails closed. Found in review: the earlier
  // version only compared the fields it happened to have, so an observation
  // that could not see the repository or the branch — a git call that failed,
  // a path that is not a worktree at all — skipped the comparison entirely and
  // fell through to `reuse`. Not knowing must never read as agreement.
  const identity: Array<[string, string | undefined, string]> = [
    ['repository', observed.repo, record.repo],
    ['branch', observed.branch, record.branch],
  ];
  for (const [what, seen, expected] of identity) {
    if (seen === undefined) return { kind: 'refuse', reason: `cannot tell which ${what} that worktree is on` };
    if (seen !== expected) return { kind: 'refuse', reason: `that worktree is on ${what} ${seen}, not ${expected}` };
  }

  if (request.repo !== record.repo) {
    return { kind: 'refuse', reason: `the record is for ${record.repo}, not ${request.repo}` };
  }
  if (request.branch !== record.branch) {
    return { kind: 'refuse', reason: `that worktree is for ${record.branch}, not ${request.branch}` };
  }
  if (request.path !== record.path) {
    return { kind: 'refuse', reason: `the record is for ${record.path}, not ${request.path}` };
  }

  // Ownership must be COMPLETE and match. A half-recorded owner is a record
  // written by something that crashed midway, which is not evidence that this
  // task may write into it.
  if (!record.ownerMissionId || !record.ownerTaskId) {
    return { kind: 'refuse', reason: 'that worktree has no recorded owner' };
  }
  if (record.ownerMissionId !== request.missionId || record.ownerTaskId !== request.taskId) {
    // Refused even when clean. A clean worktree on somebody else's branch is
    // still their branch, and two tasks sharing one is the collision the
    // whole scheme exists to prevent.
    return { kind: 'refuse', reason: 'another task owns that worktree' };
  }

  return { kind: 'reuse', reason: 'the same task is picking up where it left off' };
}

export type CleanupVerdict =
  | { kind: 'remove'; reason: string }
  | { kind: 'keep'; reason: string };

export interface CleanupOptions {
  /** Task ids with a live run; their worktrees are never touched. */
  busyTaskIds?: ReadonlySet<string>;
  /**
   * Worktree IDS a human confirmed for removal despite being unmerged.
   *
   * Found in review: this used to be one batch-wide boolean, so approving the
   * removal of a single worktree in a preview authorised every unmerged one in
   * the same plan. Confirmation is per worktree because that is the unit the
   * human actually looked at.
   */
  confirmedUnmerged?: ReadonlySet<string>;
}

/**
 * Whether one recorded worktree may be removed.
 *
 * Every unknown is treated as unsafe. This is the destructive direction: being
 * wrong about `claim` costs a refused launch, being wrong here deletes work
 * that exists nowhere else. So it removes only when it can see, positively,
 * that the thing in front of it is the recorded worktree, that it is clean,
 * and that its commits are somewhere else.
 */
export function cleanupWorktree(
  record: WorktreeRecord,
  observed: ObservedWorktree,
  options: CleanupOptions = {},
): CleanupVerdict {
  if (record.ownerTaskId && options.busyTaskIds?.has(record.ownerTaskId)) {
    return { kind: 'keep', reason: 'a run is using it right now' };
  }
  if (!observed.exists) {
    return { kind: 'remove', reason: 'the directory is already gone; clearing the record' };
  }

  // Identity first, and required rather than compared-if-present. Removing the
  // wrong directory is the one mistake here with no undo, and an observation
  // that cannot name the repository or branch is not evidence of anything.
  if (observed.repo === undefined || observed.branch === undefined) {
    return { kind: 'keep', reason: 'cannot confirm which worktree that path is' };
  }
  if (observed.repo !== record.repo || observed.branch !== record.branch) {
    return {
      kind: 'keep',
      reason: `that path is ${observed.repo} on ${observed.branch}, not ${record.repo} on ${record.branch}`,
    };
  }

  // Uncommitted work is an absolute veto, and it must be positively observed:
  // trusting a `dirty` flag last written before the crash, or an observation
  // that simply did not look, is how a fleet deletes an afternoon of edits.
  if (observed.dirty !== false) {
    return { kind: 'keep', reason: observed.dirty ? 'it has uncommitted work' : 'cannot confirm it is clean' };
  }

  if (observed.merged !== true && !options.confirmedUnmerged?.has(record.id)) {
    return {
      kind: 'keep',
      reason:
        observed.merged === false
          ? `${record.branch} is not merged into its base`
          : `cannot confirm ${record.branch} is merged anywhere`,
    };
  }

  return { kind: 'remove', reason: observed.merged ? 'merged and clean' : 'clean, and removal was confirmed' };
}

/**
 * What a cleanup would do, before it does any of it.
 *
 * The plan requires the operation to be previewable. Returning the kept ones
 * with their reasons — rather than only the removable ones — is the point: the
 * human's real question is "why is that one still here?".
 */
export function cleanupPlan(
  records: readonly WorktreeRecord[],
  observe: (record: WorktreeRecord) => ObservedWorktree,
  options: CleanupOptions = {},
): Array<{ record: WorktreeRecord; verdict: CleanupVerdict }> {
  return records.map((record) => ({ record, verdict: cleanupWorktree(record, observe(record), options) }));
}
