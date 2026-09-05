import { describeRecovery, planRecovery, type RunRecovery, type TaskRecovery } from './recovery.js';
import { transact } from '../store/db.js';
import { openFleetStore, type FleetStore, type StoreResult } from '../store/index.js';

/**
 * Bringing the durable fleet up when the process starts.
 *
 * Everything under `fleet/` and `store/` has been a library until now: fully
 * tested, and reachable from nothing. This is the seam that gives it a caller —
 * the store is opened once, the file is reconciled against reality, and the
 * handle is passed to whoever needs it.
 *
 * The reconciliation is the part that has to happen HERE rather than lazily.
 * A crash leaves rows saying `running` for processes that no longer exist, and
 * every later decision — how many slots are busy, whether a task may be
 * dispatched — reads those rows. A fleet that has not been reconciled is one
 * that believes it is busy.
 */

export interface FleetBoot {
  /** Absent when the database could not be opened; the server still runs. */
  store?: FleetStore;
  /** One line for the console, whatever happened. */
  summary: string;
  close(): void;
}

/**
 * Opens the store and reconciles it, reporting rather than throwing.
 *
 * A failure here must not take the server down with it. Sessions, the board,
 * approvals and the finish chain have never needed this database, and losing
 * the mission layer because a file is locked or a migration refused would trade
 * a contained failure for a total one. `openFleetStore` already returns its
 * failure as a value for exactly this reason; this keeps that property across
 * the reconciliation too.
 */
export function startFleet(liveSessionIds: ReadonlySet<string>, path?: string): FleetBoot {
  const opened = path === undefined ? openFleetStore() : openFleetStore(path);
  if (!opened.ok) {
    return { summary: `mission layer unavailable: ${opened.message}`, close: () => {} };
  }
  const store = opened.value;
  const recovered = recoverFleet(store, liveSessionIds);
  if (!recovered.ok) {
    // The store is CLOSED and not handed back. Found in review, and it is the
    // sharper half of this file's own argument: an unreconciled file still says
    // `running` for processes that are gone, so every later decision reads
    // those rows and the fleet believes it is busy. Serving that store is worse
    // than serving none — the mission layer being absent is visible and
    // contained, while a fleet that will not dispatch and cannot say why is
    // neither.
    store.close();
    return { summary: `mission layer unavailable: recovery failed: ${recovered.message}`, close: () => {} };
  }
  return { store, summary: recovered.value, close: () => store.close() };
}

/**
 * Reconciles every mission's persisted runs and tasks against live sessions.
 *
 * Returns a one-line account rather than the transitions, because the caller is
 * a console line and an event row; anything wanting detail reads the log.
 *
 * Recovery runs for EVERY mission, not only active ones. A paused mission's
 * rows are just as stale after a crash, and leaving them saying `running` means
 * the wedge is still there waiting the moment somebody resumes it.
 */
export function recoverFleet(store: FleetStore, liveSessionIds: ReadonlySet<string>): StoreResult<string> {
  const missions = store.missions.list();
  if (!missions.ok) return missions;

  const accounts: string[] = [];
  for (const mission of missions.value) {
    const tasks = store.tasks.listByMission(mission.id);
    if (!tasks.ok) return tasks;
    const runs = store.runs.listByMission(mission.id);
    if (!runs.ok) return runs;

    // Applied for EVERY mission, including the ones with nothing to reconcile.
    // Found in review: skipping those wrote no event, which contradicted the
    // contract stated on `applyRecovery` below — "recovered 0 runs" after a
    // clean restart is what distinguishes it from a restart where recovery
    // never ran, and nothing else in the file can tell those apart later. The
    // skip made the cheap case the one with no audit trail.
    const plan = planRecovery(tasks.value, runs.value, liveSessionIds);
    const applied = applyRecovery(store, mission.id, plan);
    if (!applied.ok) return applied;
    // The SUMMARY still only names missions that changed: it is one console
    // line, and listing every quiet mission would bury the one that moved.
    // What must be complete is the log, not the line.
    if (plan.runs.some((r) => r.kind !== 'leave') || plan.tasks.length > 0) {
      accounts.push(`${mission.name}: ${applied.value}`);
    }
  }
  return { ok: true, value: accounts.length === 0 ? 'fleet recovered, nothing to reconcile' : accounts.join('; ') };
}

/**
 * Writes one mission's recovery, runs and tasks together.
 *
 * One transaction over both halves, because they are only correct together.
 * `recovery.ts` says so in its own words: writing a task back to `ready` while
 * its run row still says `running` leaves the reconciler counting an occupied
 * slot forever — a wedge that reads as a busy fleet. Landing one without the
 * other is exactly what a partial write would do.
 *
 * The event is appended inside the same transaction. It is the only durable
 * record that recovery ran at all, and "recovered 0 runs" written after a clean
 * restart is what distinguishes that from a restart where recovery never
 * happened — a distinction nothing else in the file can make later.
 */
function applyRecovery(
  store: FleetStore,
  missionId: string,
  plan: { runs: readonly RunRecovery[]; tasks: readonly TaskRecovery[] },
): StoreResult<string> {
  return transact(store.db, 'recover the fleet after a restart', () => {
    for (const run of plan.runs) {
      if (run.kind !== 'orphan') continue;
      const moved = store.runs.setState(run.runId, run.to, { terminalReason: run.reason });
      if (!moved.ok) throw new Error(moved.message);
    }
    for (const task of plan.tasks) {
      // In order, and every hop. `path` is the legal ROUTE, not a hint: a task
      // caught `running` goes `running -> failed -> ready`, because the state
      // machine has no edge straight back to the queue. A caller that wrote
      // only the last element would have its write refused.
      for (const status of task.path) {
        const moved = store.tasks.setStatus(task.taskId, status);
        if (!moved.ok) throw new Error(moved.message);
      }
    }
    const account = describeRecovery(plan.runs, plan.tasks);
    const logged = store.events.append({
      missionId,
      actor: 'system',
      kind: 'fleet_recovered',
      payload: { account, runs: plan.runs.length, tasks: plan.tasks.length },
    });
    if (!logged.ok) throw new Error(logged.message);
    return account;
  });
}
