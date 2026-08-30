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

  if (observed.repo && observed.repo !== record.repo) {
    return { kind: 'refuse', reason: `that path belongs to ${observed.repo}, not ${record.repo}` };
  }
  if (request.repo !== record.repo) {
    return { kind: 'refuse', reason: `the record is for ${record.repo}, not ${request.repo}` };
  }
  if (observed.branch && observed.branch !== record.branch) {
    return {
      kind: 'refuse',
      reason: `the worktree is on ${observed.branch} but the record says ${record.branch}`,
    };
  }
  if (record.branch !== request.branch) {
    return { kind: 'refuse', reason: `that worktree is for ${record.branch}, not ${request.branch}` };
  }

  const owner = ownerOf(record);
  if (owner && owner !== `${request.missionId}/${request.taskId}`) {
    // Refused even when clean. A clean worktree on somebody else's branch is
    // still their branch, and two tasks sharing one is the collision the
    // whole scheme exists to prevent.
    return { kind: 'refuse', reason: 'another task owns that worktree' };
  }

  return { kind: 'reuse', reason: 'the same task is picking up where it left off' };
}

function ownerOf(record: WorktreeRecord): string | undefined {
  return record.ownerMissionId && record.ownerTaskId
    ? `${record.ownerMissionId}/${record.ownerTaskId}`
    : undefined;
}

export type CleanupVerdict =
  | { kind: 'remove'; reason: string }
  | { kind: 'keep'; reason: string };

export interface CleanupOptions {
  /** Task ids with a live run; their worktrees are never touched. */
  busyTaskIds?: ReadonlySet<string>;
  /** A human said to remove it anyway. Still cannot override uncommitted work. */
  confirmedUnmerged?: boolean;
}

/**
 * Whether one recorded worktree may be removed.
 *
 * Uncommitted work is an absolute veto — not overridable by a flag, because
 * the only way to be sure is to look, and a fleet running unattended cannot.
 * Unmerged-but-committed is a softer case: the commits survive on the branch,
 * so a human who has seen the preview may confirm it.
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
  if (observed.dirty ?? record.dirty) {
    return { kind: 'keep', reason: 'it has uncommitted work' };
  }
  if (observed.merged === false && !options.confirmedUnmerged) {
    return { kind: 'keep', reason: `${record.branch} is not merged into its base` };
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
