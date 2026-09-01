import type { ChildRun, EscalationSeverity, TaskStatus } from '@claudia/shared';
import { escalationKey } from './capabilities.js';
import { dispatchKey } from './reconcile.js';
import { backoffMs, DEFAULT_WATCHDOG, minutes, usablePolicy, type WatchdogPolicy } from './watchdog-policy.js';

/**
 * Noticing that a child has stopped being useful.
 *
 * An unattended fleet's characteristic failure is not a crash — a crash is
 * loud and the run ends. It is a child that is technically alive and getting
 * nowhere: parked on an approval nobody will answer, looping, or silent
 * because the process died underneath its record. All three look identical
 * from the board ("running"), and all three burn a concurrency slot forever.
 *
 * Deliberately deterministic: no jitter, no clock reads, no randomness. A
 * watchdog that behaves differently on two identical inputs cannot be reasoned
 * about at three in the morning, and the thing it guards is a bounded retry
 * loop — the one place where being wrong costs money on every iteration.
 */

export interface RunObservation {
  run: ChildRun;
  /** The session still exists in the manager. */
  sessionAlive: boolean;
  /** When the session last produced anything at all. */
  lastActivityAt?: number;
  /** The highest attempt any run for this task has spent. Absent falls back to
   * this run's own attempt — but then the watchdog and the reconciler can
   * disagree about whether a task is exhausted, and propose an attempt number
   * that is already taken. */
  attemptsSpent?: number;
  /** Tool name it is parked on, when it is parked. */
  pendingApproval?: string;
  /** When it parked. */
  pendingSince?: number;
  now: number;
}

export type RunHealth =
  | { kind: 'healthy' }
  | { kind: 'finished' }
  | { kind: 'orphaned'; reason: string }
  /** `tool` is the STABLE identity of what it is stuck on. `reason` contains
   * an elapsed time and therefore changes every tick, so anything derived
   * from it drifts — which is how the escalation key defeated its own
   * deduplication. */
  | { kind: 'stuck'; reason: string; tool: string }
  | { kind: 'silent'; reason: string };

/**
 * What is actually wrong with one run, in the order that matters.
 *
 * Order is deliberate: a run whose session is gone is orphaned even if it also
 * looks silent, because the fix is different. Reporting the shallower symptom
 * would send the retry logic down the wrong path.
 */
export function assess(observation: RunObservation, policy: WatchdogPolicy = DEFAULT_WATCHDOG): RunHealth {
  const { run, now } = observation;
  // A policy nobody can read is not a policy. Found in review: a non-finite
  // threshold made every comparison below false, so every run was healthy
  // forever — the same shape as the NaN clock, one input over. `pendingSince`
  // is checked at its own branch below, where an unreadable timestamp now
  // falls through to the `stuck` arm rather than reading as healthy: not
  // knowing how long it has waited is not evidence that it has not waited long.
  if (!usablePolicy(policy)) {
    return { kind: 'silent', reason: 'the watchdog policy is not usable' };
  }
  if (run.state === 'stopped' || run.state === 'failed' || run.state === 'reported') {
    return { kind: 'finished' };
  }
  if (!observation.sessionAlive) {
    return { kind: 'orphaned', reason: 'the record says running but the session is gone' };
  }
  // Everything past here is arithmetic on the clock. Found in review: an
  // unreadable `now` made the parked-approval branch below return `healthy`
  // forever, because `NaN >= threshold` is false — the same shape as the silent
  // check further down, which was already guarded, reached through a different
  // branch. Whether it is stuck or merely quiet cannot be told without a clock,
  // and `silent` is the answer that gets it looked at.
  if (!Number.isFinite(now)) {
    return { kind: 'silent', reason: 'cannot tell what time it is' };
  }
  if (observation.pendingApproval && Number.isFinite(observation.pendingSince)) {
    const waited = now - (observation.pendingSince ?? Number.NaN);
    if (waited >= policy.approvalStuckAfterMs) {
      return {
        kind: 'stuck',
        reason: `waiting ${minutes(waited)} for approval of ${observation.pendingApproval}`,
        tool: observation.pendingApproval,
      };
    }
    // Parked but not yet long enough to call it: still healthy, and saying so
    // keeps a slow human from being treated as a fault.
    return { kind: 'healthy' };
  }
  if (observation.pendingApproval) {
    // Parked, with no record of when. Treated as stuck rather than falling
    // through to the silence check, which would RETRY it — spending a fresh
    // turn that parks on the same approval. Not knowing how long it has waited
    // is not evidence that it has not waited long.
    return {
      kind: 'stuck',
      reason: `waiting for approval of ${observation.pendingApproval}`,
      tool: observation.pendingApproval,
    };
  }
  const since = observation.lastActivityAt ?? run.startedAt;
  const quiet = now - since;
  // An unreadable clock is not evidence of life. Found by audit: `NaN >= x` is
  // false, so a single bad timestamp made every run healthy forever — the one
  // fault this module exists to catch, silenced by the arithmetic that catches
  // it. Treated as silence, because "I cannot tell whether it has been working"
  // is exactly what silence means here.
  if (!Number.isFinite(quiet)) {
    return { kind: 'silent', reason: 'cannot tell when it was last doing anything' };
  }
  if (quiet >= policy.silentAfterMs) {
    return { kind: 'silent', reason: `nothing for ${minutes(quiet)}` };
  }
  return { kind: 'healthy' };
}

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
  | { kind: 'give_up'; reason: string; terminal: 'failed'; task: TaskOutcome };

/**
 * When the run stopped being useful — the fixed point a backoff counts from.
 *
 * A run that ended has an end time. One that is merely silent has not ended,
 * so the anchor is when it last did anything; failing that, when it started.
 * None of these change between ticks, which is the whole requirement.
 */
export function retryAnchor(observation: RunObservation): number {
  return observation.run.endedAt ?? observation.lastActivityAt ?? observation.run.startedAt;
}

/** When the fault this action answers first became visible. */
function faultAt(health: RunHealth, observation: RunObservation, policy: WatchdogPolicy): number {
  const anchor = retryAnchor(observation);
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
  if (health.kind === 'healthy' || health.kind === 'finished') return { kind: 'wait' };

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
  // Counted over the TASK, like `spent` above, not over this one run. Found
  // reviewing this file: `next` came from max(run.attempt, attemptsSpent) but
  // the delay came from run.attempt alone, so a task whose OTHER runs had
  // burned the attempts got the shortest backoff on its most expensive retry —
  // an action announcing "attempt 5" with the 30-second delay for attempt 1.
  // The comment on `spent` gives the reason and it applies just as much here:
  // one run's number is not the task's.
  const afterMs = backoffMs(spent, policy);
  const notBefore = faultAt(health, observation, policy) + afterMs;
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
