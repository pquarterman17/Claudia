import type { Mission, Task, TaskStatus } from '@claudia/shared';
import { transact } from '../store/db.js';
import { note } from './pulse-report.js';
import { childCeiling, isActiveRun, type Decision } from './reconcile.js';
import { assess, nextAction, type RunObservation, type WatchdogPolicy } from './watchdog.js';
import type { LaunchOrder, PulseDeps, PulseResult } from './pulse.js';

/**
 * The durable writes one pulse makes: what a decision does to the file, and
 * what the watchdog's findings do to it.
 *
 * Split out of `pulse.ts` at the 400-line ceiling, along the seam the module
 * already had — `pulse.ts` orchestrates (read the mission, compute, commit,
 * launch after the commit) and everything here is a write inside that one
 * transaction. Every function in this file may throw, and throwing is how it
 * refuses: the transaction is the unit, so a write that cannot land takes the
 * rest of the pulse with it rather than leaving half of one applied.
 *
 * The types come back from `pulse.ts` as types only, so the import is erased
 * and the runtime dependency stays one-directional.
 */

/**
 * At most one task outcome per task, whatever its runs individually decided.
 *
 * Found in review, and the reason the watchdog's task half could not stay a
 * per-run loop: the reconciler treats two active runs against one task as a
 * persisted state it must survive, so two of them can be orphaned in the same
 * pulse. Applying a full task transition for each meant the first moved the
 * task `running -> failed -> ready` and the second tried the same route from
 * `ready`, which the state machine has no edge for — the write was refused,
 * the transaction rolled back, and NEITHER run was terminalized. The runs are
 * ended independently; the task moves once, after every run has been read.
 */
interface TaskIntent {
  to: 'ready' | 'failed';
  reason: string;
  /** Present only for a retry, and only then is a launch owed. */
  attempt?: number;
  key?: string;
}

export function applyDecision(
  decision: Decision,
  mission: Mission,
  tasks: readonly Task[],
  deps: PulseDeps,
  result: PulseResult,
  orders: LaunchOrder[],
): void {
  const { store } = deps;
  switch (decision.kind) {
    case 'block':
    case 'unblock': {
      // A pure task-state change: nothing is spent, so it is safe to apply
      // without a launcher. `blocked` and `ready` are the two states the
      // reconciler itself reads on the next pulse, which is what makes an
      // unapplied block repeat forever.
      const to = decision.kind === 'block' ? 'blocked' : 'ready';
      const current = tasks.find((task) => task.id === decision.taskId);
      if (current?.status === to) return;
      const moved = store.tasks.setStatus(decision.taskId, to);
      if (!moved.ok) throw new Error(moved.message);
      note(store, mission.id, decision.taskId, `task_${decision.kind}ed`, decision.reason);
      return;
    }
    case 'dispatch': {
      if (deps.launch) {
        // RESERVED before it is queued. Found in review: an order that only
        // sat in an array left the task `ready` with no run row even after the
        // launcher returned true, so the next pulse computed the same attempt
        // and paid for it again — forever. The run row IS the reservation:
        // the store's UNIQUE (task, attempt) refuses a second one, and the
        // reconciler counts it as an occupied slot from the moment it lands.
        orders.push(reserve(decision.taskId, decision.attempt, decision.key, mission, deps));
        return;
      }
      // Recorded, not swallowed. A fleet that decided to dispatch and could
      // not is a different thing from a fleet with nothing to do, and the
      // difference is only visible if it is written down.
      result.deferred += 1;
      note(store, mission.id, decision.taskId, 'dispatch_deferred', `${decision.reason} (no launcher is wired yet)`);
      return;
    }
    case 'hold':
      // Written down after all, and the earlier reasoning here was wrong about
      // its own tooling: `note` is idempotent on (mission, kind + reason), so
      // a hold that repeats every fifteen seconds lands ONCE, not once a tick.
      // The fear of burying the log was answered before it was written.
      //
      // And a hold is not always "nothing to do". A mission that has spent its
      // budget holds, and that is the single most informative thing the log
      // can carry: without it a stalled mission is indistinguishable from a
      // broken one, which is the same complaint that put reasons on `hold` in
      // the first place.
      //
      // No task id, because this hold is about the mission. `note` keys on the
      // mission alone in that case rather than on the string "undefined".
      note(store, mission.id, undefined, 'mission_held', decision.reason);
      return;
  }
}

/**
 * Every active run assessed, then each task moved at most once.
 *
 * Two passes, because a task's outcome is not a property of any one of its
 * runs. The first ends the runs the watchdog has finished with and records
 * what each wanted done to its task; the second reconciles those wants against
 * the task's CURRENT state and against whether any run of that task survived.
 */
export function applyWatchdogOutcomes(
  mission: Mission,
  observations: readonly RunObservation[],
  policy: WatchdogPolicy,
  deps: PulseDeps,
  result: PulseResult,
  orders: LaunchOrder[],
): void {
  const { store } = deps;
  const wanted = new Map<string, TaskIntent>();
  /** Tasks with a run this pulse did NOT end, and which therefore still own them. */
  const held = new Set<string>();

  for (const observation of observations) {
    const run = observation.run;
    const action = nextAction(assess(observation, policy), observation, policy);
    switch (action.kind) {
      case 'wait':
      case 'backoff':
        // `backoff` is a fault whose retry is not due yet. Nothing to write:
        // the next pulse recomputes it from the same fixed anchor, so a row
        // now would be one per tick for a decision that has not changed.
        held.add(run.taskId);
        continue;
      case 'escalate': {
        const filed = store.escalations.create({
          missionId: mission.id,
          taskId: run.taskId,
          runId: run.id,
          // `system`, not `child`: this is the watchdog's own finding about a
          // run, not something the run asked for. A `child` source is
          // untrusted input by definition, and mislabelling it here would let
          // a stuck run look like it had requested its own escalation.
          source: 'system',
          request: action.request,
          reason: action.reason,
          severity: action.severity,
          idempotencyKey: action.key,
        });
        // Thrown, not swallowed. Found in review, and my comment here was
        // simply wrong about the repository: `create` already answers an
        // idempotency hit by returning the EXISTING row as `ok`, so a failure
        // is a real store error. Letting it pass committed the rest of the
        // pulse and advanced the cadence while the blocking escalation — the
        // thing a human is supposed to answer — had been dropped.
        if (!filed.ok) throw new Error(filed.message);
        // In the log as well as the inbox. Found by audit: an escalation was
        // filed into a table with no wire surface and no note in the timeline,
        // so the one thing a human is supposed to answer left no trace they
        // could see — a watched mission simply stopped moving. The note is
        // idempotent on the same reason, so a fault that re-escalates does not
        // fill the log.
        note(store, mission.id, run.taskId, 'escalated', `${action.request}: ${action.reason}`);
        result.escalated += 1;
        // An escalation does not end the run: it is still active, still
        // holding its task, and still occupying a slot.
        held.add(run.taskId);
        continue;
      }
      case 'give_up':
      case 'retry': {
        // The run is finished either way: it is not coming back, and leaving
        // it `running` holds a concurrency slot for the life of the mission.
        const ended = store.runs.setState(run.id, action.terminal, { terminalReason: action.reason });
        if (!ended.ok) throw new Error(ended.message);
        const intent: TaskIntent =
          action.kind === 'retry'
            ? { to: 'ready', reason: action.reason, attempt: action.attempt, key: action.key }
            : { to: 'failed', reason: action.reason };
        wanted.set(run.taskId, worseOf(wanted.get(run.taskId), intent));
        continue;
      }
    }
  }

  for (const [taskId, intent] of wanted) {
    applyTaskIntent(taskId, intent, held.has(taskId), mission, deps, result, orders);
  }
}

/**
 * `failed` beats `ready` when two runs of one task disagree.
 *
 * They are computed from the same attempt count — `nextAction` measures spend
 * over the task, not the run — so disagreement means something has already
 * gone strange. Giving up is the answer that cannot overspend, and the bound
 * on spending is the property worth keeping when the inputs are confusing.
 */
function worseOf(existing: TaskIntent | undefined, next: TaskIntent): TaskIntent {
  if (existing === undefined) return next;
  return existing.to === 'failed' ? existing : next.to === 'failed' ? next : existing;
}

function applyTaskIntent(
  taskId: string,
  intent: TaskIntent,
  stillHeld: boolean,
  mission: Mission,
  deps: PulseDeps,
  result: PulseResult,
  orders: LaunchOrder[],
): void {
  const { store } = deps;
  if (stillHeld) {
    // Another run of this task is alive. Ending its sibling must not requeue
    // the task out from under it, or the survivor finishes into a task that
    // has already been handed to somebody else.
    note(store, mission.id, taskId, 'run_ended_task_held', `${intent.reason}; another run of this task is still active`);
    return;
  }
  // Read from the STORE, not from the snapshot this pulse opened with. Found
  // in review: `applyDecision` runs first inside this same transaction and can
  // move a task — a `ready` task with an active run goes `blocked` the moment
  // a dependency reopens — so the array is already out of date by the time the
  // watchdog's half looks at it. Believing it queued a retry launch against a
  // row that had just been blocked.
  const current = store.tasks.get(taskId);
  if (!current.ok) throw new Error(current.message);
  const from = current.value?.status;
  const route = routeTo(from, intent.to);
  if (route === undefined) {
    // Left where it is, deliberately. The commonest case is `blocked`, which
    // the state machine allows a running task to enter — a dependency reopened
    // while it worked — and from which there is no edge to `failed` at all.
    // Forcing the running-only route there had the write refused and the whole
    // pulse rolled back, wedging the very run this was meant to clean up.
    // Blocked is also the correct state to leave it in: the reconciler
    // unblocks it when its dependencies resolve, and bounds the retry by the
    // same attempt count this did.
    note(store, mission.id, taskId, 'task_left_as_is', `${intent.reason}; the task is ${from ?? 'unknown'}`);
    return;
  }
  for (const status of route) {
    const moved = store.tasks.setStatus(taskId, status);
    if (!moved.ok) throw new Error(moved.message);
  }
  if (intent.to === 'failed') {
    note(store, mission.id, taskId, 'task_given_up', intent.reason);
    return;
  }
  if (intent.attempt === undefined || intent.key === undefined) return;
  if (deps.launch && hasFreeSlot(mission, deps)) {
    orders.push(reserve(taskId, intent.attempt, intent.key, mission, deps));
    return;
  }
  result.deferred += 1;
  const why = deps.launch ? 'no free child slot; the reconciler will dispatch it when one opens' : 'no launcher is wired yet';
  note(store, mission.id, taskId, 'retry_deferred', `${intent.reason} (${why})`);
}

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
function hasFreeSlot(mission: Mission, deps: PulseDeps): boolean {
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
function reserve(taskId: string, attempt: number, key: string, mission: Mission, deps: PulseDeps): LaunchOrder {
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

/**
 * The legal route from where the task actually is to where the watchdog wants it.
 *
 * Derived rather than fixed. `TASK_REQUEUED` and `TASK_GIVEN_UP` both start at
 * `failed`, which is only reachable from `running` — so the constant encodes an
 * assumption the state machine does not make, that every active run's task is
 * `running`. `undefined` means "leave it alone", which is always safe: the run
 * has been terminalized either way, and the reconciler decides again next pulse.
 */
function routeTo(from: TaskStatus | undefined, to: 'ready' | 'failed' | 'running'): readonly TaskStatus[] | undefined {
  if (from === undefined) return undefined;
  if (from === to) return [];
  if (to === 'running') return from === 'ready' ? ['running'] : undefined;
  // `running -> failed` is the one edge into `failed`, and `failed -> ready`
  // the one edge back out: a requeue is two hops, not a jump.
  if (from === 'running') return to === 'failed' ? ['failed'] : ['failed', 'ready'];
  if (to === 'ready' && (from === 'failed' || from === 'reported')) return ['ready'];
  return undefined;
}
