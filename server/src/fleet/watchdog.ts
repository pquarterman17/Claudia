import type { ChildRun, EscalationSeverity, SessionState, TaskStatus } from '@claudia/shared';
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
  /** What the session says it is doing. Absent means nobody said. */
  state?: SessionState;
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
  /**
   * The child finished its turn, which for a fleet child is it saying the work
   * is done. A CLAIM, not a verdict — `reported` is a separate state from
   * `accepted` precisely so that somebody checks.
   */
  | { kind: 'done'; reason: string }
  /** Reserved, and not yet answered by a session. Not a fault until it ages. */
  | { kind: 'starting' }
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
    // A run that has NEVER had a session is a different thing from one whose
    // session is gone, and only the second is an orphan. The first is a
    // reservation whose launcher has not attached an id yet — the row is
    // written before the child is started, deliberately, so that a repeated
    // pulse cannot pay for the same attempt twice. Retiring it during that
    // window costs the attempt and launches a duplicate of a child that was
    // still coming up. `startedAt` is the anchor because it is when the
    // reservation was made.
    if (run.sessionId === undefined && run.state === 'dispatched' && now - run.startedAt < policy.startingGraceMs) {
      return { kind: 'starting' };
    }
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
  // A child that finished its turn is DONE, not silent — and until this branch
  // existed there was no path to `reported` at all. A fleet child that did its
  // work perfectly went idle, sat out `silentAfterMs`, and was retried: the
  // same brief, at full price, until the attempts ran out and the task was
  // failed. The fleet could not succeed.
  //
  // `idle` is the SDK's word for a turn that ended, not for a pause between
  // tool calls, so for a child given one brief it means the child is finished.
  // The grace is there for the seconds between a session being created and its
  // first turn starting, where a tile can read idle before it has done
  // anything: a finished child stays idle, so it reports one tick later, while
  // a starting one has moved on.
  if (
    observation.state === 'idle' &&
    Number.isFinite(since) &&
    since > run.startedAt &&
    now - since >= policy.doneGraceMs
  ) {
    return { kind: 'done', reason: 'the child finished its turn' };
  }
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
