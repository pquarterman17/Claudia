import type { Mission } from '@claudia/shared';
import { transact } from '../store/db.js';
import type { LaunchOrder, PulseDeps } from './pulse.js';
import { note } from './pulse-report.js';
import { childCeiling, isActiveRun, routeTo } from './reconcile.js';

/**
 * Claiming an attempt, and releasing one that never started.
 *
 * The three functions that touch the run row as a RESERVATION rather than as a
 * record: whether there is room for another, writing the one that claims a
 * slot, and undoing it when the child it described never came up. Split from
 * `pulse-apply.ts` when the success path pushed that file over the size
 * ceiling, and this is the coherent half — everything here is about the
 * concurrency slot, and nothing else in the module is.
 */

/**
 * Whether the mission may start another child right now.
 *
 * The same admission check `reconcile` makes, from the same `childCeiling`, and
 * the reason it has to be made here too: this path reserves and launches
 * directly, so without it a retry was authorised by nothing. Found in review,
 * reproduced at `maxChildren: 0` — one orphaned run was retired and instantly
 * replaced, giving a mission that may run no children exactly one. The same
 * shape means a ceiling lowered under a fleet already above it never drains:
 * every run that dies is replaced one for one.
 *
 * Counted from the STORE, not from the snapshot this pulse opened with. The
 * runs this transaction has already terminalized are gone from it and the ones
 * it has already reserved are in it, which is what makes the count the state a
 * new child would actually join. An unreadable ceiling is not a licence to
 * spend, so it answers no.
 *
 * The task has already been routed back to `ready` by the time this says no, so
 * refusing here defers the retry rather than dropping it: the reconciler
 * dispatches it on a later pulse, under this same ceiling.
 */
export function hasFreeSlot(mission: Mission, deps: PulseDeps): boolean {
  const ceiling = childCeiling(mission, deps.policy);
  if (ceiling === undefined) return false;
  const runs = deps.store.runs.listByMission(mission.id);
  if (!runs.ok) throw new Error(runs.message);
  return runs.value.filter((run) => isActiveRun(run.state)).length < ceiling;
}

/**
 * Claims the attempt durably, then hands back the order to launch after commit.
 *
 * The run row is the reservation. Writing it inside the transaction is what
 * makes a repeated pulse safe: the store refuses a second run at the same
 * (task, attempt), and the reconciler counts the row as an occupied slot the
 * moment it lands, so nothing recomputes this dispatch. The task moves to
 * `running` with it, or the reconciler would keep seeing a queued task it has
 * already paid for.
 *
 * A launch that then fails to start is undone by `compensateLaunch` below,
 * which is the compensating write this ordering requires: the reservation is
 * durable, so something has to release it.
 */
export function reserve(taskId: string, attempt: number, key: string, mission: Mission, deps: PulseDeps): LaunchOrder {
  const { store } = deps;
  const run = store.runs.create({
    missionId: mission.id,
    taskId,
    // The mission's choice, recorded on the attempt that spends it. The run
    // row is what the launcher reads, so a mission edited between the
    // reservation and the launch cannot change what a started child is.
    agent: mission.agent,
    attempt,
    state: 'dispatched',
  });
  // Thrown, so a reservation that loses its race takes the launch with it. A
  // duplicate here means another pulse already claimed this attempt, and the
  // one thing that must not happen is launching anyway.
  if (!run.ok) throw new Error(run.message);
  const current = store.tasks.get(taskId);
  if (!current.ok) throw new Error(current.message);
  for (const status of routeTo(current.value?.status, 'running') ?? []) {
    const moved = store.tasks.setStatus(taskId, status);
    if (!moved.ok) throw new Error(moved.message);
  }
  return { missionId: mission.id, taskId, runId: run.value.id, agent: run.value.agent, attempt, key };
}

/**
 * Releases a reservation whose child never started.
 *
 * Called after the commit, so it is its own transaction, and it does NOT throw:
 * the pulse it belongs to has already landed, and failing to undo one launch
 * must not discard the rest of it. The task goes back to `ready` so the next
 * pulse can try again — at the next attempt, since this one is spent, which is
 * what keeps a launcher that always fails bounded by `maxAttempts` instead of
 * looping.
 */
export function compensateLaunch(deps: PulseDeps, missionId: string, order: LaunchOrder, reason: string): void {
  const { store } = deps;
  const undone = transact(store.db, 'release a launch that never started', () => {
    const ended = store.runs.setState(order.runId, 'failed', { terminalReason: reason });
    if (!ended.ok) throw new Error(ended.message);
    const current = store.tasks.get(order.taskId);
    if (!current.ok) throw new Error(current.message);
    for (const status of routeTo(current.value?.status, 'ready') ?? []) {
      const moved = store.tasks.setStatus(order.taskId, status);
      if (!moved.ok) throw new Error(moved.message);
    }
    note(store, missionId, order.taskId, 'launch_failed', `attempt ${order.attempt} did not start: ${reason}`);
    return true;
  });
  if (!undone.ok) {
    console.error(`[claudia] could not release run ${order.runId} after a failed launch:`, undone.message);
  }
}
