import type { Mission, Task } from '@claudia/shared';
import { note } from './pulse-report.js';
import { hasFreeSlot, reserve } from './pulse-reserve.js';
import { routeTo, type Decision } from './reconcile.js';
import { nextAction } from './watchdog-action.js';
import type { WatchdogPolicy } from './watchdog-policy.js';
import { assess, type RunObservation } from './watchdog.js';
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
  to: 'ready' | 'failed' | 'reported';
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
      case 'report': {
        // The run is finished, and finished WELL — the only path in the fleet
        // that ends a run without calling it a failure. Terminalized for the
        // same reason as the others: a completed run left `running` holds a
        // concurrency slot for the life of the mission.
        const ended = store.runs.setState(run.id, action.terminal, { terminalReason: action.reason });
        if (!ended.ok) throw new Error(ended.message);
        wanted.set(run.taskId, worseOf(wanted.get(run.taskId), { to: 'reported', reason: action.reason }));
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
  // `failed` still wins, and now it wins over `reported` too: one run claiming
  // to have finished does not answer another run of the same task having
  // failed, and the answer that cannot overspend is still the one to keep when
  // two runs of one task disagree. The claim is not lost — its run row records
  // it — only the task's status defers to the worse news.
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
  if (intent.to === 'reported') {
    // A claim, in the log, waiting on a person. Nothing is accepted here: the
    // whole reason `reported` and `accepted` are separate states is that a
    // child saying it finished is not evidence that it did.
    result.reported += 1;
    note(store, mission.id, taskId, 'task_reported', intent.reason);
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
