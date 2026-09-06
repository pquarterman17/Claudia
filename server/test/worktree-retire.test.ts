import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupWorktree } from '../src/fleet/worktree-owner.js';
import { retireWorktree, retireWorktrees, type RetireFacts } from '../src/fleet/worktree-retire.js';
import { startFleet } from '../src/fleet/boot.js';
import { pulseMission, type SessionFacts } from '../src/fleet/pulse.js';
import type { FleetStore } from '../src/store/index.js';
import type { WorktreeRecord } from '@claudia/shared';

/**
 * Letting go of a worktree the fleet has finished with.
 *
 * `cleanupWorktree`'s first substantive check is `record.state === 'active'`,
 * and nothing in the fleet had ever written any other state: `claimWorktree`
 * writes `active` on the way in and no path wrote anything on the way out. So
 * cleanup answered "the fleet still has it marked active" about every worktree
 * that has ever existed — a module that could not reach its own first
 * decision — and a mission finished last month still claimed to be holding its
 * directories open.
 *
 * Nothing here moves anything on disk. That half is deliberately absent.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-retire-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOBODY: RetireFacts = { busyTaskIds: new Set(), unreadTaskIds: new Set() };

function record(over: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: 'w1',
    repo: '/repo',
    path: '/repo/.worktrees/t1',
    branch: 'claudia/t1',
    baseSha: 'a'.repeat(40),
    ownerMissionId: 'm1',
    ownerTaskId: 't1',
    state: 'active',
    dirty: false,
    lastSeenAt: 0,
    createdAt: 0,
    ...over,
  };
}

describe('deciding whether a worktree is finished with', () => {
  it('holds one a run is writing into', () => {
    const facts = { busyTaskIds: new Set(['t1']), unreadTaskIds: new Set<string>() };
    expect(retireWorktree(record(), facts)).toEqual({ kind: 'hold', reason: 'a run is using it right now' });
  });

  it('holds one whose report has not been judged', () => {
    // The run is done with the directory; the server is not. Judging reads the
    // branch, the diff and the head, and runs the mission's verify command
    // inside it.
    const facts = { busyTaskIds: new Set<string>(), unreadTaskIds: new Set(['t1']) };
    expect(retireWorktree(record(), facts).kind).toBe('hold');
  });

  it('holds one with a half-written owner, like claim and cleanup do', () => {
    // Both owner columns are ON DELETE SET NULL, so a record with a task and
    // no mission is one the schema permits. `claimWorktree` refuses to write
    // into it; retiring it on weaker evidence would make this the more
    // permissive of the two, which is how the destructive path gets fed.
    expect(retireWorktree(record({ ownerMissionId: undefined }), NOBODY).kind).toBe('hold');
    expect(retireWorktree(record({ ownerTaskId: undefined }), NOBODY).kind).toBe('hold');
  });

  it('holds one that has already been let go of', () => {
    expect(retireWorktree(record({ state: 'idle' }), NOBODY)).toEqual({ kind: 'hold', reason: 'it is already idle' });
    expect(retireWorktree(record({ state: 'archived' }), NOBODY).kind).toBe('hold');
  });

  it('retires one no run is using', () => {
    expect(retireWorktree(record(), NOBODY)).toEqual({ kind: 'retire', reason: 'no run is using it' });
  });
});

let counter = 0;
/** A mission with one task, one worktree, and whatever runs are asked for. */
function fixture() {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);

  const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
  if (!task.ok) throw new Error(task.message);
  const worktree = store.worktrees.create({
    repo: '/repo',
    path: join(dir, `wt-${counter}`),
    branch: 'claudia/t',
    baseSha: 'a'.repeat(40),
    ownerMissionId: mission.value.id,
    ownerTaskId: task.value.id,
  });
  if (!worktree.ok) throw new Error(worktree.message);
  return { store, missionId: mission.value.id, taskId: task.value.id, worktreeId: worktree.value.id };
}

function run(store: FleetStore, missionId: string, taskId: string, state: 'running' | 'reported') {
  const created = store.runs.create({ missionId, taskId, agent: 'claude', state: 'dispatched' });
  if (!created.ok) throw new Error(created.message);
  for (const to of state === 'running' ? (['running'] as const) : (['running', 'reported'] as const)) {
    const moved = store.runs.setState(created.value.id, to);
    if (!moved.ok) throw new Error(moved.message);
  }
  return created.value.id;
}

function stateOf(store: FleetStore, worktreeId: string): string {
  const read = store.worktrees.get(worktreeId);
  if (!read.ok) throw new Error(read.message);
  return read.value?.state ?? 'gone';
}

describe('the retire pass', () => {
  it('leaves a worktree alone while its run is alive', () => {
    const { store, missionId, taskId, worktreeId } = fixture();
    run(store, missionId, taskId, 'running');
    expect(retireWorktrees(store, missionId)).toBe(0);
    expect(stateOf(store, worktreeId)).toBe('active');
  });

  it('leaves it alone between the report and the verdict', () => {
    const { store, missionId, taskId, worktreeId } = fixture();
    run(store, missionId, taskId, 'reported');
    expect(retireWorktrees(store, missionId)).toBe(0);
    expect(stateOf(store, worktreeId)).toBe('active');
  });

  it('lets it go once the report has been judged', () => {
    const { store, missionId, taskId, worktreeId } = fixture();
    const runId = run(store, missionId, taskId, 'reported');
    const judged = store.events.append({
      missionId,
      taskId,
      runId,
      actor: 'system',
      kind: 'task_judged',
      payload: { verdict: 'needs_human', reason: 'green', missing: [] },
      idempotencyKey: `judged:${runId}`,
    });
    if (!judged.ok) throw new Error(judged.message);

    expect(retireWorktrees(store, missionId)).toBe(1);
    expect(stateOf(store, worktreeId)).toBe('idle');
  });

  it('says nothing twice: a second pass has nothing left to retire', () => {
    const { store, missionId, worktreeId } = fixture();
    expect(retireWorktrees(store, missionId)).toBe(1);
    expect(retireWorktrees(store, missionId)).toBe(0);
    expect(stateOf(store, worktreeId)).toBe('idle');
  });

  it('runs on the pulse, after the judging that reads the directory', async () => {
    // The wiring, not just the decision. `judgeReported` and this pass are
    // both after the pulse's commit, in that order: judging reads the
    // worktree, so a report read on this tick leaves a directory this pass may
    // then let go of on the same tick.
    const { store, missionId, worktreeId } = fixture();
    const mission = store.missions.get(missionId);
    if (!mission.ok || !mission.value) throw new Error('no mission');

    const result = await pulseMission(mission.value, {
      store,
      policy: { maxChildren: 4, maxAttempts: 3 },
      observeSessions: () => new Map<string, SessionFacts>(),
    });
    expect(result?.retired).toBe(1);
    expect(stateOf(store, worktreeId)).toBe('idle');
  });

  it('is what makes cleanup reachable at all', () => {
    // The join the two halves were missing. Before the pass, every record said
    // `active` and cleanup's first check answered "keep" for all of them —
    // whatever the directory on disk actually was.
    const { store, missionId, worktreeId } = fixture();
    const before = store.worktrees.get(worktreeId);
    if (!before.ok || !before.value) throw new Error('no record');
    const clean = { exists: true, repo: '/repo', branch: 'claudia/t', dirty: false, merged: true };
    const options = { busyTaskIds: new Set<string>() };

    expect(cleanupWorktree(before.value, clean, options)).toEqual({
      kind: 'keep',
      reason: 'the fleet still has it marked active',
    });

    retireWorktrees(store, missionId);
    const after = store.worktrees.get(worktreeId);
    if (!after.ok || !after.value) throw new Error('no record');
    const verdict = cleanupWorktree(after.value, clean, options);
    expect(verdict.kind).toBe('remove');
  });
});
