import { isLegalRoute, WORKTREE_TRANSITIONS, type WorktreeRecord, type WorktreeState } from '@claudia/shared';
import { worktreePathKey } from '../path-key.js';

/**
 * Whether two paths name the same place.
 *
 * Windows reaches one directory by many spellings — case, forward or back
 * slashes, a trailing separator — and this module refuses on mismatch, so a
 * spelling difference becomes a refused launch rather than a wrong one. That
 * is the safe direction, but it is still wrong, and on the platform this app
 * is actually developed on.
 *
 * The platform is a parameter because a comparison that is inert on the host
 * the tests run on is not tested at all — the same trap that made an earlier
 * path fix in this repo look correct on Linux and fail on a Windows runner.
 */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const key = platform === 'win32' ? 'win32' : 'posix';
  return worktreePathKey(a, key) === worktreePathKey(b, key);
}

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
  /** Absent means nobody could tell. Every other fact here is tri-state and
   * refuses on unknown; `exists` was the one required boolean, so a caller
   * whose `statSync` threw had to say `false` — the single value that skips
   * the identity, dirty, merged and confirmation vetoes and returns `remove`. */
  exists?: boolean;
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
  /** No live record holds this path: a brand new row, and a directory to match. */
  | { kind: 'create'; reason: string }
  /**
   * A record already holds this path. `path` is the legal route from where
   * that record is to `active`, and `createDirectory` says whether the
   * directory itself still has to be made.
   *
   * Found by audit: this used to say `create` whenever the directory was
   * missing, for records in every state. `worktrees_live_path` is
   * `UNIQUE (path) WHERE state <> 'removed'`, so an active, idle, stale or
   * archived row still owns that path and the insert was refused —
   * "UNIQUE constraint failed: worktrees.path" — for all four. A decision the
   * store cannot carry out is not a decision, which is the same lesson
   * `CleanupVerdict.path` was added for.
   */
  | { kind: 'adopt'; path: readonly WorktreeState[]; createDirectory: boolean; reason: string }
  | { kind: 'refuse'; reason: string };

/**
 * The route from a record's current state to `active`.
 *
 * `removed` is deliberately absent: that row no longer owns its path (the
 * unique index exempts it), so the answer there is a new row, not a revival.
 */
function toActive(state: WorktreeState): readonly WorktreeState[] | undefined {
  // `removed` is terminal in WORKTREE_TRANSITIONS, so it has no route back and
  // saying `['active']` would be a decision the store refuses — which the two
  // identical tail arms this replaces did say, and which the comment above
  // already claimed they did not. `removalRoute` next door answers `undefined`
  // for a state with no route; this now matches it.
  if (state === 'removed') return undefined;
  return state === 'active' ? [] : ['active'];
}

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
  if (observed.exists === undefined) {
    return { kind: 'refuse', reason: 'cannot tell whether anything is at that path' };
  }
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

  if (record.state === 'removed' && !observed.exists) {
    // `removed` is the one state that frees the path, so a fresh row is what
    // the unique index permits. It carries no owner to check against, because
    // the record it came from is history.
    return { kind: 'create', reason: 'the previous worktree here was removed' };
  }
  if ((record.state === 'removed' || record.state === 'archived') && observed.exists) {
    return { kind: 'refuse', reason: `the record says ${record.state} but the directory is still there` };
  }

  // WHAT THE RECORD SAYS, checked before anything is decided and WITHOUT
  // needing the directory to exist. Found by audit: the missing-directory
  // return used to sit above these, so a task asking for a different
  // repository, a different branch, a different path or another mission's work
  // was handed the row anyway as long as the directory happened to be gone.
  // The identical request with the directory PRESENT was refused — the safety
  // of this function depended on the filesystem, which is the one input it
  // cannot trust. Before this branch the answer there was `create`, which the
  // unique index refused: a failed launch, but safe. `adopt` succeeds, and
  // leaves a row that lies about which repository and branch it holds while
  // locking its rightful owner out.
  if (request.repo !== record.repo) {
    return { kind: 'refuse', reason: `the record is for ${record.repo}, not ${request.repo}` };
  }
  if (request.branch !== record.branch) {
    return { kind: 'refuse', reason: `that worktree is for ${record.branch}, not ${request.branch}` };
  }
  if (!samePath(request.path, record.path)) {
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

  if (!observed.exists) {
    // Nothing can be lost by rebuilding: the directory is gone, and the branch
    // (with any commits on it) survives independently. The ROW stays, because
    // it still owns the path. Reached only after everything above has agreed
    // that this row is this task's.
    const path = toActive(record.state);
    if (!path) {
      return { kind: 'refuse', reason: `a worktree that is ${record.state} cannot be made active again` };
    }
    return {
      kind: 'adopt',
      path,
      createDirectory: true,
      reason:
        record.state === 'archived'
          ? 'reviving an archived worktree whose directory is gone'
          : 'the recorded worktree is missing from disk',
    };
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
    const matches = what === 'repository' ? samePath(seen, expected) : seen === expected;
    if (!matches) return { kind: 'refuse', reason: `that worktree is on ${what} ${seen}, not ${expected}` };
  }

  const reviveRoute = toActive(record.state);
  if (!reviveRoute) {
    return { kind: 'refuse', reason: `a worktree that is ${record.state} cannot be made active again` };
  }
  return {
    kind: 'adopt',
    // A worktree being picked up is `active` again; an idle or stale record
    // left saying so is one the reconciler and the cleanup both misread.
    path: reviveRoute,
    createDirectory: false,
    reason: 'the same task is picking up where it left off',
  };
}

export type CleanupVerdict =
  /**
   * `path` is the legal route to `removed`, in order, and applying only its
   * last element gets the write refused: `removed` is reachable only from
   * `archived`, so a finished worktree goes `idle -> archived -> removed`.
   * Carried here rather than left to the caller because a caller that has just
   * been told "remove" will write `removed`, and this module knows better.
   */
  | { kind: 'remove'; path: readonly WorktreeState[]; reason: string }
  | { kind: 'keep'; reason: string };

/**
 * The route to `removed` from where the record actually is.
 *
 * Named per starting state rather than searched for: `removed` is reachable
 * only through `archived`, and archiving first is the step that makes a
 * removal previewable. A record already `removed` has no route and no work to
 * do — saying "remove" there would be a decision nobody can act on.
 */
function removalRoute(state: WorktreeState): readonly WorktreeState[] | undefined {
  if (state === 'archived') return ['removed'];
  if (state === 'idle' || state === 'stale') return ['archived', 'removed'];
  return undefined;
}

/** A removal that is legal from where the record actually is. */
function removal(record: WorktreeRecord, reason: string): CleanupVerdict {
  const route = removalRoute(record.state);
  if (!route || !isLegalRoute(record.state, route, WORKTREE_TRANSITIONS)) {
    return { kind: 'keep', reason: `a worktree that is ${record.state} cannot be removed` };
  }
  return { kind: 'remove', path: route, reason };
}

export interface CleanupOptions {
  /**
   * Task ids with a live run; their worktrees are never touched.
   *
   * REQUIRED. Found in review: while this was optional, a caller that simply
   * had no activity snapshot — a startup before the store is read, a failed
   * query — got the same answer as one that had looked and found nothing, and
   * a worktree in active use could be removed for being clean and merged.
   */
  busyTaskIds: ReadonlySet<string>;
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
  options: CleanupOptions,
): CleanupVerdict {
  // An unowned record cannot be checked against the activity snapshot, so it
  // cannot be shown to be idle. claimWorktree already refuses to WRITE into
  // one of these ("no recorded owner"); deleting it on the same evidence
  // would make the destructive path the more permissive of the two.
  // BOTH owner fields, matching claimWorktree. Found by audit: this checked
  // only the task, so a record with a task but no mission — which the schema
  // permits, since both owner columns are ON DELETE SET NULL — was refused by
  // `claim` and REMOVED by `cleanup`. The comment below says this branch exists
  // to stop the destructive path being the more permissive of the two, and it
  // was, on exactly that record.
  if (!record.ownerTaskId || !record.ownerMissionId) {
    return { kind: 'keep', reason: 'that worktree has no recorded owner' };
  }
  if (options.busyTaskIds.has(record.ownerTaskId)) {
    return { kind: 'keep', reason: 'a run is using it right now' };
  }
  // A record the fleet still considers active is not a cleanup candidate,
  // whatever the filesystem says. The activity snapshot answers "is a run
  // holding it"; this answers "did anyone ever say it was finished with".
  if (record.state === 'active') {
    return { kind: 'keep', reason: 'the fleet still has it marked active' };
  }
  // Tri-state, and checked in that order. Found by audit: this read
  // `!observed.exists`, and `exists` is optional with "absent means nobody
  // could tell" written on it — so an observation that FAILED took the removal
  // branch, ahead of the identity, dirty and merged vetoes that are all
  // correctly tri-state. It removed a worktree with uncommitted work in it on
  // an observation that never looked, and `claimWorktree` refuses that same
  // unknown, which made the destructive path the more permissive of the two.
  if (observed.exists === undefined) {
    return { kind: 'keep', reason: 'cannot tell whether anything is at that path' };
  }
  if (observed.exists === false) {
    return removal(record, 'the directory is already gone; clearing the record');
  }

  // Identity first, and required rather than compared-if-present. Removing the
  // wrong directory is the one mistake here with no undo, and an observation
  // that cannot name the repository or branch is not evidence of anything.
  if (observed.repo === undefined || observed.branch === undefined) {
    return { kind: 'keep', reason: 'cannot confirm which worktree that path is' };
  }
  if (!samePath(observed.repo, record.repo) || observed.branch !== record.branch) {
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

  return removal(record, observed.merged ? 'merged and clean' : 'clean, and removal was confirmed');
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
  options: CleanupOptions,
): Array<{ record: WorktreeRecord; verdict: CleanupVerdict }> {
  return records.map((record) => ({ record, verdict: cleanupWorktree(record, observe(record), options) }));
}
