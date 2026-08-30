import type { WorktreeRecord } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import {
  claimWorktree,
  cleanupPlan,
  cleanupWorktree,
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

  it('reuses its own worktree', () => {
    expect(claimWorktree(REQUEST, record(), there)).toMatchObject({ kind: 'reuse' });
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

  it('rebuilds a recorded worktree that has vanished from disk', () => {
    // Nothing can be lost: the directory is gone and the branch survives it.
    expect(claimWorktree(REQUEST, record(), gone)).toMatchObject({ kind: 'create' });
  });

  it.each(['archived', 'removed'] as const)('refuses a %s record whose directory is still there', (state) => {
    const verdict = claimWorktree(REQUEST, record({ state }), there);
    expect(verdict.kind).toBe('refuse');
    expect(verdict.reason).toContain('still there');
  });

  it.each(['archived', 'removed'] as const)('re-creates from a %s record once the directory is gone', (state) => {
    expect(claimWorktree(REQUEST, record({ state }), gone)).toMatchObject({ kind: 'create' });
  });

  it('treats an unowned record as claimable', () => {
    const orphan = record();
    delete orphan.ownerMissionId;
    delete orphan.ownerTaskId;
    expect(claimWorktree(REQUEST, orphan, there)).toMatchObject({ kind: 'reuse' });
  });
});

describe('cleanupWorktree', () => {
  it('never removes a worktree with uncommitted work', () => {
    const verdict = cleanupWorktree(record(), { ...there, dirty: true });
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'it has uncommitted work' });
  });

  it('will not let a confirmation override uncommitted work', () => {
    // The only way to know it is safe is to look, and an unattended fleet
    // cannot. So this veto has no override.
    const verdict = cleanupWorktree(record(), { ...there, dirty: true, merged: true }, { confirmedUnmerged: true });
    expect(verdict.kind).toBe('keep');
  });

  it('trusts the record when nothing was observed about dirtiness', () => {
    expect(cleanupWorktree(record({ dirty: true }), { exists: true }).kind).toBe('keep');
  });

  it('keeps an unmerged branch unless a human confirmed it', () => {
    const verdict = cleanupWorktree(record(), { ...there, merged: false });
    expect(verdict.kind).toBe('keep');
    expect(verdict.reason).toContain('not merged');
  });

  it('removes an unmerged branch once confirmed, because the commits survive', () => {
    const verdict = cleanupWorktree(record(), { ...there, merged: false }, { confirmedUnmerged: true });
    expect(verdict.kind).toBe('remove');
  });

  it('removes a merged, clean worktree', () => {
    expect(cleanupWorktree(record(), { ...there, merged: true })).toMatchObject({ kind: 'remove' });
  });

  it('keeps a worktree whose task is running right now', () => {
    const verdict = cleanupWorktree(record(), { ...there, merged: true }, { busyTaskIds: new Set(['t1']) });
    expect(verdict).toMatchObject({ kind: 'keep', reason: 'a run is using it right now' });
  });

  it('clears the record when the directory is already gone', () => {
    expect(cleanupWorktree(record(), gone)).toMatchObject({ kind: 'remove' });
  });
});

describe('cleanupPlan', () => {
  it('reports the kept ones with their reasons, not just the removable ones', () => {
    // The human's real question is why something is still there.
    const keepMe = record({ id: 'w-dirty', dirty: true });
    const dropMe = record({ id: 'w-clean' });
    const plan = cleanupPlan([keepMe, dropMe], (r) => ({ ...there, dirty: r.dirty, merged: true }));
    expect(plan.map((p) => [p.record.id, p.verdict.kind])).toEqual([
      ['w-dirty', 'keep'],
      ['w-clean', 'remove'],
    ]);
    expect(plan[0]?.verdict.reason).toContain('uncommitted');
  });
});
