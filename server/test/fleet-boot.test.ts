import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { recoverFleet, startFleet } from '../src/fleet/boot.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The seam that gives the durable fleet a caller.
 *
 * Everything asserted here is about the boundary rather than the algorithms:
 * `recovery.ts` already proves which transitions are right, and repeating that
 * would only pin the same logic twice. What was untested until now is that the
 * store is opened at all, that a failure to open leaves the server standing,
 * and that the transitions actually land — together, in the file.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-fleet-boot-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
/** A store with one mission, one task, and one run left mid-flight by a crash. */
function crashed(over: { sessionId?: string } = {}) {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  const store = boot.store;
  if (!store) throw new Error(boot.summary);
  opened.push(store);

  const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
  if (!task.ok) throw new Error(task.message);
  const run = store.runs.create({
    missionId: mission.value.id,
    taskId: task.value.id,
    agent: 'claude',
    attempt: 1,
    sessionId: over.sessionId ?? 's1',
  });
  if (!run.ok) throw new Error(run.message);

  // Where a crash leaves them: the run running, the task running, and nothing
  // on either row saying the process is gone.
  const running = store.runs.setState(run.value.id, 'running');
  if (!running.ok) throw new Error(running.message);
  for (const status of ['ready', 'running'] as const) {
    const moved = store.tasks.setStatus(task.value.id, status);
    if (!moved.ok) throw new Error(moved.message);
  }
  return { store, missionId: mission.value.id, taskId: task.value.id, runId: run.value.id };
}

describe('opening the fleet at startup', () => {
  it('opens the store and says so', () => {
    const boot = startFleet(new Set(), join(dir, 'fresh', 'fleet.db'));
    if (boot.store) opened.push(boot.store);
    expect(boot.store).toBeDefined();
    expect(boot.summary).toContain('nothing to reconcile');
  });

  it('leaves the server standing when the database cannot be opened', () => {
    // The whole reason `openFleetStore` reports failure as a value. Sessions,
    // the board, approvals and the finish chain have never needed this file;
    // losing the mission layer because one is unreadable must not take the rest
    // of the process with it.
    // A plain file where the database's directory has to be, so creating it
    // fails before SQLite is ever reached.
    writeFileSync(join(dir, 'blocked'), 'not a directory');
    const boot = startFleet(new Set(), join(dir, 'blocked', 'fleet.db'));
    expect(boot.store).toBeUndefined();
    expect(boot.summary).toContain('mission layer unavailable');
    // And closing a boot that never opened anything is still safe to call.
    expect(() => boot.close()).not.toThrow();
  });
});

describe('reconciling what a crash left behind', () => {
  it('orphans a run whose session did not survive, and requeues its task', () => {
    const { store, taskId, runId } = crashed();
    const account = recoverFleet(store, new Set());
    expect(account.ok, account.ok ? '' : account.message).toBe(true);

    const run = store.runs.get(runId);
    expect(run.ok && run.value?.state).toBe('failed');
    // Back in the queue, by the only legal route: `running -> failed -> ready`.
    const task = store.tasks.get(taskId);
    expect(task.ok && task.value?.status).toBe('ready');
  });

  it('adopts a run whose session is still there', () => {
    // Claudia's sessions can outlive a browser, and a server restarted by a
    // supervisor that kept them still resolves the ids. Orphaning those would
    // throw away work that is genuinely still running.
    const { store, taskId, runId } = crashed({ sessionId: 'still-here' });
    const account = recoverFleet(store, new Set(['still-here']));
    expect(account.ok).toBe(true);

    const run = store.runs.get(runId);
    expect(run.ok && run.value?.state).toBe('running');
    const task = store.tasks.get(taskId);
    expect(task.ok && task.value?.status).toBe('running');
  });

  it('lands the run and the task together, or not at all', () => {
    // The wedge `recovery.ts` names: a task written back to `ready` while its
    // run row still says `running` leaves the reconciler counting an occupied
    // slot forever, which reads as a busy fleet. One transaction over both
    // halves is what makes that state unreachable.
    const { store, taskId, runId } = crashed();
    expect(recoverFleet(store, new Set()).ok).toBe(true);
    const run = store.runs.get(runId);
    const task = store.tasks.get(taskId);
    const runDone = run.ok && run.value?.state === 'failed';
    const taskQueued = task.ok && task.value?.status === 'ready';
    expect(runDone).toBe(taskQueued);
  });

  it('records that recovery ran, even when it changed nothing', () => {
    // "recovered 0 runs" after a clean restart is what distinguishes it from a
    // restart where recovery never happened at all, and nothing else in the
    // file can tell those apart afterwards.
    const { store, missionId } = crashed();
    expect(recoverFleet(store, new Set()).ok).toBe(true);
    const events = store.events.sinceForMission(missionId);
    if (!events.ok) throw new Error(events.message);
    const recovered = events.value.filter((event) => event.kind === 'fleet_recovered');
    expect(recovered).toHaveLength(1);
    expect(String(JSON.stringify(recovered[0]?.payload))).toContain('orphaned 1');
  });

  it('reconciles a mission nobody is watching', () => {
    // `paused` is a WATCH state, not a status: the mission is still active,
    // just unattended. Its rows are as stale after a crash as anyone else's,
    // and skipping them leaves the wedge in place for whoever resumes it.
    const { store, missionId, taskId } = crashed();
    const paused = store.missions.setWatch(missionId, 'paused');
    expect(paused.ok, paused.ok ? '' : paused.message).toBe(true);
    expect(recoverFleet(store, new Set()).ok).toBe(true);
    const task = store.tasks.get(taskId);
    expect(task.ok && task.value?.status).toBe('ready');
  });
});
