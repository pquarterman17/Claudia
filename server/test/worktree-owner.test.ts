import { isLegalRoute, WORKTREE_TRANSITIONS } from '@claudia/shared';
import type { WorktreeRecord } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import {
  claimWorktree,
  cleanupPlan,
  cleanupWorktree,
  samePath,
  type ClaimRequest,
  type ObservedWorktree,
} from '../src/fleet/worktree-owner.js';

/**
 * Every case here is a disagreement between what the fleet recorded and what
 * is actually on disk. Those are the ones that lose work, and they are exactly
 * the ones nobody stages by hand — which is why the rules are pure.
 */

function record(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: 'w1',
    repo: '/repo',
    path: '/repo-worktrees/task-1',
    branch: 'claudia/task-1',
    baseSha: 'abc123',
    ownerMissionId: 'm1',
    ownerTaskId: 't1',
    state: 'active',
    dirty: false,
    lastSeenAt: 1,
    createdAt: 1,
    ...over,
  };
}

const REQUEST: ClaimRequest = {
  repo: '/repo',
  path: '/repo-worktrees/task-1',
  branch: 'claudia/task-1',
  missionId: 'm1',
  taskId: 't1',
};

const there: ObservedWorktree = { exists: true, repo: '/repo', branch: 'claudia/task-1', dirty: false };
/** An activity snapshot that was actually taken and found nothing running. */
const IDLE = { busyTaskIds: new Set<string>() };

/** A worktree the fleet has finished with — the only kind cleanup considers. */
function finished(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return record({ state: 'idle', ...over });
}
const gone: ObservedWorktree = { exists: false };

describe('claimWorktree', () => {
  it('creates when there is neither a record nor a directory', () => {
    expect(claimWorktree(REQUEST, undefined, gone)).toMatchObject({ kind: 'create' });
  });

  it('refuses a directory the fleet has no record of', () => {
    // The ambiguous case: somebody else put it there, and the existing
    // launch path would have silently reused it.
    const verdict = claimWorktree(REQUEST, undefined, there);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('no record of it');
  });

  it('adopts its own worktree, and says how the record gets back to active', () => {
    expect(claimWorktree(REQUEST, record(), there)).toMatchObject({ kind: 'adopt', createDirectory: false });
  });

  it.each(['idle', 'stale'] as const)('routes a %s record back to active rather than leaving it there', (state) => {
    // A record left saying idle is one the reconciler and the cleanup both
    // misread — cleanup treats idle as a removal candidate.
    expect(claimWorktree(REQUEST, record({ state }), there)).toMatchObject({
      kind: 'adopt',
      path: ['active'],
      createDirectory: false,
    });
  });

  it('refuses a worktree owned by another task, even when it is clean', () => {
    // Clean is not the same as free: it is still that task's branch.
    const verdict = claimWorktree(REQUEST, record({ ownerTaskId: 't2' }), there);
    expect(verdict).toMatchObject({ kind: 'refuse', reason: 'another task owns that worktree' });
  });

  it('refuses when the directory belongs to a different repository', () => {
    const verdict = claimWorktree(REQUEST, record(), { ...there, repo: '/somewhere-else' });
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('/somewhere-else');
  });

  it('refuses when the checkout is on a different branch than the record', () => {
    const verdict = claimWorktree(REQUEST, record(), { ...there, branch: 'main' });
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('main');
  });

  it('refuses when the request asks for a branch the record is not for', () => {
    const verdict = claimWorktree({ ...REQUEST, branch: 'other' }, record(), there);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('claudia/task-1');
  });

  it('refuses when the request names a different repository than the record', () => {
    const verdict = claimWorktree({ ...REQUEST, repo: '/other' }, record(), { exists: true, branch: 'claudia/task-1' });
    expect(verdict.kind).toBe('refuse');
  });

  it('rebuilds a recorded worktree that has vanished from disk, keeping the row', () => {
    // Nothing can be lost: the directory is gone and the branch survives it.
    // Found by audit: this said `create`, and the row still owns the path —
    // `worktrees_live_path` is UNIQUE where state <> 'removed', so the insert
    // was refused. The directory is rebuilt; the record is adopted.
    expect(claimWorktree(REQUEST, record(), gone)).toMatchObject({ kind: 'adopt', createDirectory: true });
  });

  it.each(['archived', 'removed'] as const)('refuses a %s record whose directory is still there', (state) => {
    const verdict = claimWorktree(REQUEST, record({ state }), there);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('still there');
  });

  it('creates a new row once the previous worktree here was removed', () => {
    // `removed` is the one state that frees the path: the unique index exempts
    // it, so a new row is exactly what can be written.
    expect(claimWorktree(REQUEST, record({ state: 'removed' }), gone)).toMatchObject({ kind: 'create' });
  });

  it('revives an archived record rather than writing a second row for its path', () => {
    expect(claimWorktree(REQUEST, record({ state: 'archived' }), gone)).toMatchObject({
      kind: 'adopt',
      path: ['active'],
      createDirectory: true,
    });
  });

  it('refuses a record with no owner rather than treating it as free', () => {
    // Changed in review. A half-recorded owner is a record written by
    // something that crashed midway — not evidence that this task may write
    // into the directory.
    const orphan = record();
    delete orphan.ownerMissionId;
    delete orphan.ownerTaskId;
    expect(claimWorktree(REQUEST, orphan, there)).toMatchObject({ kind: 'refuse' });
  });

  it.each([['ownerMissionId'], ['ownerTaskId']])('refuses a record missing %s', (missing) => {
    const partial = record() as unknown as Record<string, unknown>;
    delete partial[missing];
    expect(claimWorktree(REQUEST, partial as never, there).kind).toBe('refuse');
  });

  it.each([['repo'], ['branch']])('refuses when the observation cannot name the %s', (field) => {
    // The core fail-open bug: an observation that could not see the repository
    // or branch skipped the comparison and fell through to reuse. Not knowing
    // must never read as agreement.
    const blind = { ...there } as Record<string, unknown>;
    delete blind[field];
    const verdict = claimWorktree(REQUEST, record(), blind as never);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('cannot tell');
  });

  it('refuses when the request path is not the recorded one', () => {
    const verdict = claimWorktree({ ...REQUEST, path: '/somewhere/else' }, record(), there);
    expect(verdict.kind).toBe('refuse');
  });

  it('refuses when the request is for a different mission', () => {
    const verdict = claimWorktree({ ...REQUEST, missionId: 'm2' }, record(), there);
    expect(verdict).toMatchObject({ kind: 'refuse', reason: 'another task owns that worktree' });
  });
});

describe('cleanupWorktree', () => {
  it('never removes a worktree with uncommitted work', () => {
    const verdict = cleanupWorktree(finished(), { ...there, dirty: true }, IDLE);
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'it has uncommitted work' });
  });

  it('will not let a confirmation override uncommitted work', () => {
    // The only way to know it is safe is to look, and an unattended fleet
    // cannot. So this veto has no override.
    const verdict = cleanupWorktree(finished(), { ...there, dirty: true, merged: true }, {
      ...IDLE,
      confirmedUnmerged: new Set(['w1']),
    });
    expect(verdict.kind).toBe('keep');
  });

  it('keeps a worktree when nothing was observed at all', () => {
    // Rewritten: this passed `{ exists: true }`, which is existence positively
    // OBSERVED, so it kept for an unrelated reason and the name claimed
    // coverage the file did not have. The genuinely-empty observation removed,
    // and applying that removal against a real store deleted the record.
    const verdict = cleanupWorktree(finished({ dirty: true }), {}, IDLE);
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'cannot tell whether anything is at that path' });
  });

  it('will not delete on an observation that failed to look', () => {
    // The destructive direction must never be the more permissive of the two,
    // and `claimWorktree` refuses this same unknown outright.
    expect(cleanupWorktree(finished(), {}, IDLE).kind).toBe('keep');
    expect(claimWorktree(REQUEST, record(), {}).kind).toBe('refuse');
  });

  it('still clears the record when the directory is positively gone', () => {
    expect(cleanupWorktree(finished(), { exists: false }, IDLE)).toMatchObject({
      kind: 'remove',
      path: ['archived', 'removed'],
    });
  });

  it('keeps an unmerged branch unless a human confirmed it', () => {
    const verdict = cleanupWorktree(finished(), { ...there, merged: false }, IDLE);
    expect(verdict.kind).toBe('keep');
    expect(verdict.reason).toContain('not merged');
  });

  it('removes an unmerged branch once THAT worktree is confirmed', () => {
    const verdict = cleanupWorktree(finished(), { ...there, merged: false }, {
      ...IDLE,
      confirmedUnmerged: new Set(['w1']),
    });
    expect(verdict.kind).toBe('remove');
  });

  it('does not let confirming one worktree authorise another', () => {
    // Changed in review: confirmation used to be one batch-wide boolean, so
    // approving a single removal in a preview authorised every unmerged one.
    const verdict = cleanupWorktree(finished({ id: 'w2' }), { ...there, merged: false }, {
      ...IDLE,
      confirmedUnmerged: new Set(['w1']),
    });
    expect(verdict.kind).toBe('keep');
  });

  it.each([['repo'], ['branch']])('keeps a worktree whose %s cannot be confirmed', (field) => {
    const blind = { ...there, merged: true } as Record<string, unknown>;
    delete blind[field];
    const verdict = cleanupWorktree(finished(), blind as never, IDLE);
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'cannot confirm which worktree that path is' });
  });

  it('keeps a worktree whose path turns out to be a different repository', () => {
    const verdict = cleanupWorktree(finished(), { ...there, repo: '/elsewhere', merged: true }, IDLE);
    expect(verdict.kind).toBe('keep');
  });

  it('keeps a worktree when cleanliness was never observed', () => {
    // Trusting a `dirty` flag written before a crash is how a fleet deletes an
    // afternoon of edits.
    const verdict = cleanupWorktree(finished({ dirty: false }), { exists: true, repo: '/repo', branch: 'claudia/task-1', merged: true }, IDLE);
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'cannot confirm it is clean' });
  });

  it('keeps a worktree whose merge state is unknown', () => {
    const verdict = cleanupWorktree(finished(), { ...there }, IDLE);
    expect(verdict.kind).toBe('keep');
    expect(verdict.reason).toContain('cannot confirm');
  });

  it('removes a merged, clean worktree', () => {
    expect(cleanupWorktree(finished(), { ...there, merged: true }, IDLE)).toMatchObject({ kind: 'remove' });
  });

  it('keeps a worktree whose task is running right now', () => {
    const verdict = cleanupWorktree(finished(), { ...there, merged: true }, { busyTaskIds: new Set(['t1']) });
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'a run is using it right now' });
  });

  it('clears the record when the directory is already gone', () => {
    expect(cleanupWorktree(finished(), gone, IDLE)).toMatchObject({ kind: 'remove' });
  });
});

describe('cleanupPlan', () => {
  it('reports the kept ones with their reasons, not just the removable ones', () => {
    // The human's real question is why something is still there.
    const keepMe = finished({ id: 'w-dirty', dirty: true });
    const dropMe = finished({ id: 'w-clean' });
    const plan = cleanupPlan([keepMe, dropMe], (r) => ({ ...there, dirty: r.dirty, merged: true }), IDLE);
    expect(plan.map((p) => [p.record.id, p.verdict.kind])).toEqual([
      ['w-dirty', 'keep'],
      ['w-clean', 'remove'],
    ]);
    expect(plan[0]?.verdict.reason).toContain('uncommitted');
  });
});

describe('cleanup and activity', () => {
  it('keeps a worktree the fleet still has marked active', () => {
    // The activity snapshot answers "is a run holding it"; the record state
    // answers "did anyone ever say it was finished with". Both must agree.
    const verdict = cleanupWorktree(record({ state: 'active' }), { ...there, merged: true }, IDLE);
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'the fleet still has it marked active' });
  });

  it('requires an activity snapshot to have been taken at all', () => {
    // Found in review: while busyTaskIds was optional, a caller that had not
    // looked got the same answer as one that had looked and found nothing.
    // It is required now, so this no longer type-checks without one — the
    // empty set below is a snapshot, not an absence.
    expect(cleanupWorktree(finished(), { ...there, merged: true }, { busyTaskIds: new Set() }).kind).toBe('remove');
  });
});

describe('samePath', () => {
  it('treats Windows spellings of one directory as the same place', () => {
    // Case, slashes and a trailing separator all reach the same directory,
    // and refusing on a spelling difference is still being wrong — on the
    // platform this app is actually developed on.
    expect(samePath('C:\\repo\\work', 'c:/repo/work', 'win32')).toBe(true);
    expect(samePath('C:/repo/work/', 'C:/repo/work', 'win32')).toBe(true);
  });

  it('keeps case significant where the filesystem does', () => {
    expect(samePath('/repo/Work', '/repo/work', 'linux')).toBe(false);
  });

  it('still separates genuinely different paths on Windows', () => {
    expect(samePath('C:/repo/a', 'C:/repo/b', 'win32')).toBe(false);
  });

  it('is exercised for win32 from any host', () => {
    // The platform is a parameter precisely so this assertion is not inert on
    // the machine the suite happens to run on.
    expect(samePath('D:\\A\\B', 'd:/a/b', 'win32')).toBe(true);
    expect(samePath('D:\\A\\B', 'd:/a/b', 'linux')).toBe(false);
  });
});

describe('a missing directory is not a way past the checks', () => {
  /**
   * The regression this branch introduced and an audit caught. The
   * missing-directory return sat ABOVE the identity and ownership checks, so
   * the safety of this function depended on whether a directory happened to
   * exist — the one input it cannot trust. Before the `adopt` verdict the
   * answer there was `create`, which the unique index refused: a failed
   * launch, but safe. `adopt` succeeds, and leaves a row that lies about which
   * repository and branch it holds while locking its rightful owner out.
   */
  const owned = () =>
    record({ ownerMissionId: 'm-owner', ownerTaskId: 't-owner', repo: '/repo', branch: 'claudia/task-1', state: 'idle' });

  it.each([
    ['another task', { ...REQUEST, missionId: 'm-owner', taskId: 't-intruder' }],
    ['another mission', { ...REQUEST, missionId: 'm-other', taskId: 't-owner' }],
    ['another repository', { ...REQUEST, repo: '/other-repo' }],
    ['another branch', { ...REQUEST, branch: 'claudia/task-99' }],
    ['another path', { ...REQUEST, path: '/wt/somewhere-else' }],
  ])('refuses %s just the same when the directory is gone', (_who, request) => {
    const asked = { ...request, missionId: request.missionId ?? 'm-owner', taskId: request.taskId ?? 't-owner' };
    expect(claimWorktree(asked, owned(), gone).kind, 'directory gone').toBe('refuse');
    // And the answer does not change with the filesystem.
    expect(claimWorktree(asked, owned(), { ...there, repo: '/repo', branch: 'claudia/task-1' }).kind).toBe('refuse');
  });

  it('still adopts for the rightful owner', () => {
    const asked = { ...REQUEST, missionId: 'm-owner', taskId: 't-owner', repo: '/repo', branch: 'claudia/task-1' };
    expect(claimWorktree(asked, owned(), gone)).toMatchObject({ kind: 'adopt', createDirectory: true });
  });

  it('refuses a half-recorded owner even with the directory gone', () => {
    const orphan = owned();
    delete orphan.ownerMissionId;
    expect(claimWorktree(REQUEST, orphan, gone)).toMatchObject({ kind: 'refuse', reason: 'that worktree has no recorded owner' });
  });

  it('never offers a route out of removed, which the store would refuse', () => {
    // `toActive` had two identical tail arms, so `removed` answered ['active'] —
    // illegal under WORKTREE_TRANSITIONS — while its own comment claimed
    // `removed` was deliberately absent.
    for (const state of ['active', 'idle', 'stale', 'archived', 'removed'] as const) {
      const verdict = claimWorktree(
        { ...REQUEST, missionId: 'm-owner', taskId: 't-owner', repo: '/repo', branch: 'claudia/task-1' },
        record({ ownerMissionId: 'm-owner', ownerTaskId: 't-owner', repo: '/repo', branch: 'claudia/task-1', state }),
        gone,
      );
      if (verdict.kind !== 'adopt') continue;
      expect(isLegalRoute(state, verdict.path, WORKTREE_TRANSITIONS), `${state}: ${verdict.path.join(' -> ')}`).toBe(true);
    }
  });
});

describe('cleanup is never more permissive than claim', () => {
  it('keeps a record whose owner is only half recorded', () => {
    // Both owner columns are ON DELETE SET NULL, so a half-null row is a state
    // the schema permits. claimWorktree refused it; cleanupWorktree checked
    // only the task id and REMOVED it — the exact asymmetry the branch above it
    // says it exists to prevent.
    const half = finished();
    delete half.ownerMissionId;
    expect(cleanupWorktree(half, { ...there, merged: true }, IDLE)).toMatchObject({
      kind: 'keep',
      reason: 'that worktree has no recorded owner',
    });
    expect(claimWorktree(REQUEST, half, there).kind).toBe('refuse');
  });
});
