import type { Mission, Task, TaskStatus } from '@claudia/shared';
import { escalationKey } from './capabilities.js';
import type { Decision } from './reconcile.js';
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
        // Queued for after the commit. Starting it here would put an external,
        // non-transactional act inside a transaction a later write can roll
        // back, leaving a live child with no durable record of itself.
        orders.push({ missionId: mission.id, taskId: decision.taskId, attempt: decision.attempt, key: decision.key });
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
      // Explanation only. Writing a row per tick for "nothing to do" would
      // bury the log in the one state that carries no information.
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
  tasks: readonly Task[],
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
    applyTaskIntent(taskId, intent, held.has(taskId), mission, tasks, deps, result, orders);
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
  tasks: readonly Task[],
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
  const from = tasks.find((task) => task.id === taskId)?.status;
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
  if (deps.launch) {
    orders.push({ missionId: mission.id, taskId, attempt: intent.attempt, key: intent.key });
    return;
  }
  result.deferred += 1;
  note(store, mission.id, taskId, 'retry_deferred', `${intent.reason} (no launcher is wired yet)`);
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
function routeTo(from: TaskStatus | undefined, to: 'ready' | 'failed'): readonly TaskStatus[] | undefined {
  if (from === undefined) return undefined;
  if (from === to) return [];
  // `running -> failed` is the one edge into `failed`, and `failed -> ready`
  // the one edge back out: a requeue is two hops, not a jump.
  if (from === 'running') return to === 'failed' ? ['failed'] : ['failed', 'ready'];
  if (to === 'ready' && (from === 'failed' || from === 'reported')) return ['ready'];
  return undefined;
}

/** One line in the mission's timeline, keyed so a repeated tick cannot duplicate it. */
export function note(
  store: PulseDeps['store'],
  missionId: string,
  taskId: string,
  kind: string,
  reason: string,
): void {
  const appended = store.events.append({
    missionId,
    taskId,
    actor: 'system',
    kind,
    payload: { reason },
    idempotencyKey: escalationKey(`${missionId}:${taskId}`, `${kind}:${reason}`),
  });
  // A duplicate key means this exact note is already in the log, which is the
  // idempotency doing its job rather than a failure worth aborting the pulse.
  if (!appended.ok && !/idempot|unique/i.test(appended.message)) throw new Error(appended.message);
}
