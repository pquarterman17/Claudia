import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupWorktree } from '../src/fleet/worktree-owner.js';
import { planRecovery } from '../src/fleet/recovery.js';
import { reconcile } from '../src/fleet/reconcile.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

/**
 * Every other test in this repo asserts what a decision module DECIDES. This
 * one asserts the decision can be carried out.
 *
 * That gap hid two real bugs through three review rounds and twelve hundred
 * passing tests. `planRecovery` moved a crashed task straight to `ready` and
 * `cleanupWorktree` moved a finished worktree straight to `removed`; both are
 * the right intention and both are illegal in one hop, so the store refused
 * them. Nothing noticed, because nothing applied them — the modules have no
 * production caller yet, and the unit tests only ever read the verdict.
 *
 * So these tests deliberately close the loop: build real rows in a real store,
 * ask the module what to do, then do it. A decision that cannot be applied is
 * not a decision, however well tested in isolation.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-applicable-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const fleet of opened) fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function store(): FleetStore {
  const result = openFleetStore(join(dir, `db-${counter++}`, 'fleet.db'));
  if (!result.ok) throw new Error(result.message);
  opened.push(result.value);
  return result.value;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** A mission with one task, driven to `running` with a live run. */
function runningTask(fleet: FleetStore) {
  const mission = unwrap(fleet.missions.create({ name: 'm', body: '', cwd: '/repo' }));
  const task = unwrap(
    fleet.tasks.create({ missionId: mission.id, title: 't', description: '', cwd: '/repo', acceptance: '' }),
  );
  unwrap(fleet.tasks.setStatus(task.id, 'ready'));
  unwrap(fleet.tasks.setStatus(task.id, 'running'));
  const run = unwrap(
    fleet.runs.create({ missionId: mission.id, taskId: task.id, agent: 'claude', attempt: 1, sessionId: 's1' }),
  );
  unwrap(fleet.runs.setState(run.id, 'running'));
  return { mission, task, run };
}

describe('recovery decisions can be applied', () => {
  it('requeues a crashed task through a route the store accepts', () => {
    const fleet = store();
    const { mission, task } = runningTask(fleet);

    const tasks = unwrap(fleet.tasks.listByMission(mission.id));
    const runs = unwrap(fleet.runs.listByMission(mission.id));
    const plan = planRecovery(tasks, runs, new Set());

    // The destination is still the queue; only the route changed.
    expect(plan.tasks[0]).toMatchObject({ taskId: task.id, to: 'ready' });
    expect(plan.tasks[0]?.path).toEqual(['failed', 'ready']);

    for (const move of plan.tasks) {
      for (const step of move.path) {
        const applied = fleet.tasks.setStatus(move.taskId, step);
        expect(applied.ok, `${step}: ${applied.ok ? '' : applied.message}`).toBe(true);
      }
    }
    expect(unwrap(fleet.tasks.get(task.id))?.status).toBe('ready');
  });

  it('applies the run transitions too, so no slot stays occupied', () => {
    const fleet = store();
    const { mission, run } = runningTask(fleet);
    const plan = planRecovery(
      unwrap(fleet.tasks.listByMission(mission.id)),
      unwrap(fleet.runs.listByMission(mission.id)),
      new Set(),
    );
    for (const decision of plan.runs) {
      if (decision.kind !== 'orphan') continue;
      expect(fleet.runs.setState(decision.runId, decision.to).ok).toBe(true);
    }
    expect(unwrap(fleet.runs.get(run.id))?.state).toBe('failed');
  });

  it('leaves a recovered task where the reconciler will pick it up', () => {
    // The point of requeueing at all: the reconciler only dispatches `ready`
    // and `blocked`, so landing on `failed` would be a quieter wedge.
    const fleet = store();
    const { mission, task } = runningTask(fleet);
    const plan = planRecovery(
      unwrap(fleet.tasks.listByMission(mission.id)),
      unwrap(fleet.runs.listByMission(mission.id)),
      new Set(),
    );
    for (const move of plan.tasks) for (const step of move.path) unwrap(fleet.tasks.setStatus(move.taskId, step));
    for (const decision of plan.runs) {
      if (decision.kind === 'orphan') unwrap(fleet.runs.setState(decision.runId, decision.to));
    }

    // A new mission is `paused` by design — it must not start spending the
    // moment it exists — so watching it is part of the setup, not the fix.
    unwrap(fleet.missions.setWatch(mission.id, 'watching'));

    const decisions = reconcile({
      mission: unwrap(fleet.missions.get(mission.id)) as never,
      tasks: unwrap(fleet.tasks.listByMission(mission.id)),
      runs: unwrap(fleet.runs.listByMission(mission.id)),
      policy: { maxChildren: 2, maxAttempts: 3 },
    });
    expect(decisions.find((d) => d.kind === 'dispatch')).toMatchObject({ taskId: task.id, attempt: 2 });
  });
});

describe('cleanup decisions can be applied', () => {
  it.each(['idle', 'stale', 'archived'] as const)('removes a %s worktree by a route the store accepts', (state) => {
    const fleet = store();
    const mission = unwrap(fleet.missions.create({ name: 'm', body: '', cwd: '/repo' }));
    const task = unwrap(
      fleet.tasks.create({ missionId: mission.id, title: 't', description: '', cwd: '/repo', acceptance: '' }),
    );
    const worktree = unwrap(
      fleet.worktrees.create({
        repo: '/repo',
        path: `/wt/${state}`,
        branch: 'b',
        baseSha: 'a',
        ownerMissionId: mission.id,
        ownerTaskId: task.id,
        dirty: false,
      }),
    );
    if (state === 'archived') unwrap(fleet.worktrees.setState(worktree.id, 'idle'));
    unwrap(fleet.worktrees.setState(worktree.id, state));

    const record = unwrap(fleet.worktrees.get(worktree.id));
    if (!record) throw new Error('setup');
    const verdict = cleanupWorktree(
      record,
      { exists: true, repo: '/repo', branch: 'b', dirty: false, merged: true },
      { busyTaskIds: new Set() },
    );
    expect(verdict.kind).toBe('remove');
    if (verdict.kind !== 'remove') return;

    for (const step of verdict.path) {
      const applied = fleet.worktrees.setState(worktree.id, step);
      expect(applied.ok, `${step}: ${applied.ok ? '' : applied.message}`).toBe(true);
    }
    expect(unwrap(fleet.worktrees.get(worktree.id))?.state).toBe('removed');
  });

  it('keeps a worktree it cannot legally remove rather than emitting a doomed path', () => {
    // `removed` is terminal, so a record already there has no route out and
    // no route back to it. Saying "remove" would be a decision nobody can act on.
    const fleet = store();
    const mission = unwrap(fleet.missions.create({ name: 'm', body: '', cwd: '/repo' }));
    const task = unwrap(
      fleet.tasks.create({ missionId: mission.id, title: 't', description: '', cwd: '/repo', acceptance: '' }),
    );
    const worktree = unwrap(
      fleet.worktrees.create({
        repo: '/repo',
        path: '/wt/gone',
        branch: 'b',
        baseSha: 'a',
        ownerMissionId: mission.id,
        ownerTaskId: task.id,
        dirty: false,
      }),
    );
    unwrap(fleet.worktrees.setState(worktree.id, 'idle'));
    unwrap(fleet.worktrees.setState(worktree.id, 'archived'));
    unwrap(fleet.worktrees.setState(worktree.id, 'removed'));

    const record = unwrap(fleet.worktrees.get(worktree.id));
    if (!record) throw new Error('setup');
    const verdict = cleanupWorktree(record, { exists: false }, { busyTaskIds: new Set() });
    expect(verdict).toMatchObject({ kind: 'keep' });
  });
});
