import type { EscalationSeverity, TaskStatus } from '@claudia/shared';
import { escalationKey } from './capabilities.js';
import { dispatchKey } from './reconcile.js';
import { backoffMs, DEFAULT_WATCHDOG, usablePolicy, type WatchdogPolicy } from './watchdog-policy.js';
import type { RunHealth, RunObservation } from './watchdog.js';

/**
 * What may be DONE about a run, as opposed to what is wrong with it.
 *
 * The seam `watchdog.ts` names in its own comment on `nextAction`: "what is
 * wrong" and "what may be done about it" answer to different things — the
 * first is observation, the second is policy — and only the second is allowed
 * to spend another attempt. They lived in one file until the success path
 * pushed it over the size ceiling, and this is the line the module had already
 * drawn for itself.
 */

/**
 * What the TASK must be written to, and by what route.
 *
 * Found by audit: both `retry` and `give_up` said what becomes of the run and
 * nothing about the task, so applying either left the task `running`. Nothing
 * in the fleet can move it from there: `reconcile` only ever looks at `ready`
 * and `blocked`, and the watchdog only ever looks at live runs. It is the
 * exact wedge `terminal` was added to close, moved from the run row to the
 * task row — and only a restart clears it, because `recoverTasks` catches
 * running-with-nothing-running, which means it would only ever be seen in
 * production.
 *
 * Both routes go through `failed` rather than straight to the destination,
 * because that is what TASK_TRANSITIONS allows from `running` — and because it
 * is true: the attempt did fail. `recovery.ts` reaches the queue the same way
 * for the same reason.
 */
export interface TaskOutcome {
  to: TaskStatus;
  path: readonly TaskStatus[];
}

/** Back into the queue, so the reconciler can spend the next attempt. */
const TASK_REQUEUED: TaskOutcome = { to: 'ready', path: ['failed', 'ready'] };

/** Left failed, which a human can still requeue; nothing does it automatically. */
const TASK_GIVEN_UP: TaskOutcome = { to: 'failed', path: ['failed'] };

/** A claim, awaiting a decision. One step: `running` goes straight to `reported`. */
const TASK_REPORTED: TaskOutcome = { to: 'reported', path: ['reported'] };

export type WatchdogAction =
  | { kind: 'wait' }
  /**
   * `key` and `notBefore` are what stop a tick becoming a launch.
   *
   * Found in review: every tick over the same silent run returned the same
   * retry, so a pulse each minute would start a new session each minute. The
   * key is derived, so repeated ticks collide on one reservation; `notBefore`
   * is when the backoff actually expires, so a caller that has not yet reached
   * it does nothing at all.
   */
  | {
      kind: 'retry';
      afterMs: number;
      notBefore: number;
      attempt: number;
      reason: string;
      key: string;
      /** The state the OLD run must be written to before the retry starts.
       * Without it the dead run stays `running` and the reconciler counts its
       * slot as occupied forever — a wedge that reads as a busy fleet. */
      terminal: 'failed';
      /** And where the TASK goes, so something can actually pick the retry up.
       * The key below reserves in the reconciler's namespace, and the
       * reconciler only dispatches `ready` and `blocked`. */
      task: TaskOutcome;
    }
  /**
   * Faulted, and the retry is not due yet. Distinct from `wait`, which means
   * nothing is wrong: a board showing "retrying in 4m" needs to tell those
   * apart, and collapsing them would hide a failing run behind a healthy-
   * looking tile. Deliberately carries no `task` and no `terminal` — there is
   * nothing to apply yet, which is the whole point.
   */
  | { kind: 'backoff'; until: number; attempt: number; reason: string }
  | { kind: 'escalate'; request: string; reason: string; severity: EscalationSeverity; key: string }
  /** Terminal for the same reason as retry: giving up on a run must not leave
   * it holding a concurrency slot for the life of the mission — nor its task
   * stranded in `running`, which is the same wedge one row over. */
  | { kind: 'give_up'; reason: string; terminal: 'failed'; task: TaskOutcome }
  /**
   * The child says it is done. The run is terminal — it is not coming back,
   * and leaving it `running` would hold a concurrency slot forever — and the
   * task goes to `reported`, which is a claim awaiting a decision rather than
   * a finished task. Nothing here accepts anything.
   */
  | { kind: 'report'; reason: string; terminal: 'reported'; task: TaskOutcome };

/**
 * When the run stopped being useful — the fixed point a backoff counts from.
 *
 * A run that ended has an end time. One that is merely silent has not ended,
 * so the anchor is when it last did anything; failing that, when it started.
 * None of these change between ticks, which is the whole requirement.
 *
 * `undefined` when the timestamp this run's anchor comes from is unreadable.
 * Found in review: `??` falls back on absence, not on nonsense, so a
 * `lastActivityAt` of NaN was SELECTED over a perfectly good `startedAt` — and
 * every number derived from it was NaN, up to a retry announcing
 * `notBefore: NaN` that walked straight through the `now < notBefore` gate,
 * because a comparison with NaN is false. The next candidate down is not a
 * repair either: it is always EARLIER than the one that could not be read, so
 * substituting it shortens a backoff by an unknown amount. Neither reading nor
 * guessing, then; the caller escalates.
 */
export function retryAnchor(observation: RunObservation): number | undefined {
  const anchor = observation.run.endedAt ?? observation.lastActivityAt ?? observation.run.startedAt;
  return Number.isFinite(anchor) ? anchor : undefined;
}

/** When the fault this action answers first became visible. */
function faultAt(health: RunHealth, anchor: number, policy: WatchdogPolicy): number {
  return health.kind === 'silent' ? anchor + policy.silentAfterMs : anchor;
}

/** The reservation key for one retry of one run. Derived, never random. */
export function retryKey(runId: string, attempt: number): string {
  return `retry:${runId}:${attempt}`;
}

/**
 * What to do about it.
 *
 * Split from `assess` because "what is wrong" and "what may be done about it"
 * answer to different things: the first is observation, the second is policy,
 * and only the second is allowed to spend another attempt.
 *
 * A stuck approval is escalated rather than retried — retrying would park on
 * the same approval, at full price, and the plan is explicit that a child
 * cannot grant itself a capability. Only a human clears that.
 */
export function nextAction(
  health: RunHealth,
  observation: RunObservation,
  policy: WatchdogPolicy = DEFAULT_WATCHDOG,
): WatchdogAction {
  const { run } = observation;
  // `starting` waits like the others: there is nothing to do about a child that
  // is still coming up, and the grace expiring turns it into a plain orphan.
  if (health.kind === 'healthy' || health.kind === 'finished' || health.kind === 'starting') {
    return { kind: 'wait' };
  }
  // Before the policy revalidation below, deliberately. Recording that a child
  // finished spends nothing and needs no arithmetic, so an unreadable policy
  // must not turn a completed run into an escalation about the watchdog's own
  // configuration — that would lose the work AND the attempt.
  if (health.kind === 'done') {
    return { kind: 'report', reason: health.reason, terminal: 'reported', task: TASK_REPORTED };
  }

  // Revalidated HERE, not only in `assess`. Found in review: the two are
  // separate entry points and a caller composes them, so validating in one
  // proves nothing about the other. With an unusable policy every arithmetic
  // result below is NaN — `notBefore: NaN`, and `now < NaN` is false, so the
  // backoff gate waves through an executable retry announcing a delay it never
  // computed. Nothing here can be decided without a readable clock and a
  // readable policy, and picking a default would be inventing the numbers that
  // govern spending.
  if (!usablePolicy(policy) || !Number.isFinite(observation.now)) {
    return {
      kind: 'escalate',
      request: 'unusable watchdog configuration',
      reason: 'the watchdog cannot read its own policy or clock, so it will not spend another attempt',
      severity: 'blocking',
      key: escalationKey(run.id, 'unusable-watchdog-config'),
    };
  }

  if (health.kind === 'stuck') {
    return {
      kind: 'escalate',
      request: health.reason,
      reason: 'only a human can clear an approval, and retrying would park on the same one',
      severity: 'blocking',
      // Keyed on the TOOL, not the reason. The reason carries an elapsed time,
      // so keying on it produced a new key every tick — sixty distinct
      // "duplicates" an hour, which is exactly what the key was added to stop.
      key: escalationKey(run.id, health.tool),
    };
  }

  // Counted over the TASK, not this run. The reconciler bounds retries by the
  // highest attempt any of the task's runs has spent; counting from one run
  // let the watchdog propose an attempt another run already holds, and call a
  // task retryable that the reconciler had already blocked.
  const spent = Math.max(run.attempt, observation.attemptsSpent ?? run.attempt);
  // Counted, or nothing below means anything. Found in review: an
  // `attemptsSpent` of NaN produced an EXECUTABLE retry announcing
  // `attempt: NaN`, `afterMs: NaN`, `notBefore: NaN` and the reservation key
  // `dispatch:m:t:NaN` — and since `now < NaN` is false it sailed past the
  // backoff gate as well. A count that cannot be read is not a count, and
  // guessing one either re-runs work already paid for or gives up early, so
  // this is a question for a person rather than a decision to take.
  if (!Number.isSafeInteger(spent) || spent < 1 || !Number.isSafeInteger(policy.maxAttempts)) {
    return {
      kind: 'escalate',
      request: 'unreadable attempt count',
      reason: `cannot tell how many attempts ${run.taskId} has spent, so neither retrying nor giving up is safe`,
      severity: 'blocking',
      key: escalationKey(run.id, 'unreadable-attempt-count'),
    };
  }
  const next = spent + 1;
  if (next > policy.maxAttempts) {
    return {
      kind: 'give_up',
      reason: `${spent} attempt${spent === 1 ? '' : 's'} spent on this task; not starting another`,
      terminal: 'failed',
      task: TASK_GIVEN_UP,
    };
  }
  // Read before anything is computed from it, for the same reason the policy
  // and the clock are read above: this is the third input to the same
  // arithmetic, and the only one that was still taken on trust. An action is
  // the permission to spend an attempt, and a deadline nobody can compute is
  // not a deadline that has passed.
  const anchor = retryAnchor(observation);
  if (anchor === undefined) {
    return {
      kind: 'escalate',
      request: 'unreadable run timestamps',
      reason: `cannot tell when run ${run.id} stopped being useful, so there is no point to count a backoff from`,
      severity: 'blocking',
      key: escalationKey(run.id, 'unreadable-run-anchor'),
    };
  }
  // Counted over the TASK, like `spent` above, not over this one run. Found
  // reviewing this file: `next` came from max(run.attempt, attemptsSpent) but
  // the delay came from run.attempt alone, so a task whose OTHER runs had
  // burned the attempts got the shortest backoff on its most expensive retry —
  // an action announcing "attempt 5" with the 30-second delay for attempt 1.
  // The comment on `spent` gives the reason and it applies just as much here:
  // one run's number is not the task's.
  const afterMs = backoffMs(spent, policy);
  const notBefore = faultAt(health, anchor, policy) + afterMs;
  // Withheld until it is actually due, rather than emitted early with a
  // "do not act on this yet" attached.
  //
  // Found reviewing the commit that gave this action its `task` route. The
  // backoff lives here; the dispatch lives in the reconciler; and the only
  // thing joining them is a task status, which carries no timing. So the
  // moment a caller applies `task` -- which is the whole point of it, the
  // hand-off that lets the retry be picked up -- the reconciler dispatches on
  // its next pulse whatever `notBefore` said. Measured: notBefore 30s away,
  // task moved to `ready`, dispatched on the very next pulse.
  //
  // Nothing downstream can honour a deadline it is never told about, so the
  // module that owns the deadline waits instead. `notBefore` stays on the
  // action as the record of when it came due, not as an instruction.
  if (observation.now < notBefore) {
    return { kind: 'backoff', until: notBefore, attempt: next, reason: health.reason };
  }
  return {
    kind: 'retry',
    attempt: next,
    afterMs,
    // Anchored on something that does not move. Found in review: anchoring on
    // `now` meant the deadline advanced with every tick and was never reached,
    // and defaulting `now` to 0 failed the other way — instantly eligible,
    // forever. All three fallbacks here are fixed points in the run's past, so
    // ticking more often cannot change when the retry becomes due.
    // Counted from when the fault became DETECTABLE, not from when activity
    // stopped. Silence is only declared after `silentAfterMs` (15m), and the
    // backoff caps at `retryMaxMs` (10m), so anchoring on last activity made
    // every silent-path deadline already expired — the backoff was structurally
    // dead on the commonest failure, and only `maxAttempts` bounded anything.
    notBefore,
    reason: health.reason,
    // The SAME namespace the reconciler reserves in. Two key spaces meant a
    // watchdog retry and a reconciler dispatch of one task's one attempt could
    // both be reserved, which is the thing keys exist to prevent.
    key: dispatchKey(run.missionId, run.taskId, next),
    terminal: 'failed',
    task: TASK_REQUEUED,
  };
}

// Re-exported so `watchdog.js` stays the one module a caller asks about the
// watchdog, whatever side of the split a symbol happens to live on.
export { backoffMs, DEFAULT_WATCHDOG, type WatchdogPolicy } from './watchdog-policy.js';
