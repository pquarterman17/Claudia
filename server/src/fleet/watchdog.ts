import type { ChildRun, EscalationSeverity } from '@claudia/shared';

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

export interface WatchdogPolicy {
  /** No output at all for this long is treated as silence, not thinking. */
  silentAfterMs: number;
  /** A pending approval older than this will not be answered by anyone. */
  approvalStuckAfterMs: number;
  maxAttempts: number;
  /** First retry delay; doubles per attempt up to retryMaxMs. */
  retryBaseMs: number;
  retryMaxMs: number;
}

export const DEFAULT_WATCHDOG: WatchdogPolicy = {
  // Generous: a long build or a big refactor legitimately goes quiet, and a
  // watchdog that kills real work is worse than one that reacts late.
  silentAfterMs: 15 * 60_000,
  // Shorter, because a parked approval is not work in progress — nothing is
  // happening and nothing will until a human acts.
  approvalStuckAfterMs: 5 * 60_000,
  maxAttempts: 3,
  retryBaseMs: 30_000,
  retryMaxMs: 10 * 60_000,
};

export interface RunObservation {
  run: ChildRun;
  /** The session still exists in the manager. */
  sessionAlive: boolean;
  /** When the session last produced anything at all. */
  lastActivityAt?: number;
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
  | { kind: 'stuck'; reason: string }
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
  if (run.state === 'stopped' || run.state === 'failed' || run.state === 'reported') {
    return { kind: 'finished' };
  }
  if (!observation.sessionAlive) {
    return { kind: 'orphaned', reason: 'the record says running but the session is gone' };
  }
  if (observation.pendingApproval && observation.pendingSince !== undefined) {
    const waited = now - observation.pendingSince;
    if (waited >= policy.approvalStuckAfterMs) {
      return {
        kind: 'stuck',
        reason: `waiting ${minutes(waited)} for approval of ${observation.pendingApproval}`,
      };
    }
    // Parked but not yet long enough to call it: still healthy, and saying so
    // keeps a slow human from being treated as a fault.
    return { kind: 'healthy' };
  }
  const since = observation.lastActivityAt ?? run.startedAt;
  const quiet = now - since;
  if (quiet >= policy.silentAfterMs) {
    return { kind: 'silent', reason: `nothing for ${minutes(quiet)}` };
  }
  return { kind: 'healthy' };
}

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
  | { kind: 'retry'; afterMs: number; notBefore: number; attempt: number; reason: string; key: string }
  | { kind: 'escalate'; request: string; reason: string; severity: EscalationSeverity; key: string }
  | { kind: 'give_up'; reason: string };

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
  run: ChildRun,
  policy: WatchdogPolicy = DEFAULT_WATCHDOG,
  now = 0,
): WatchdogAction {
  if (health.kind === 'healthy' || health.kind === 'finished') return { kind: 'wait' };

  if (health.kind === 'stuck') {
    return {
      kind: 'escalate',
      request: health.reason,
      reason: 'only a human can clear an approval, and retrying would park on the same one',
      severity: 'blocking',
      // Stable, so a pulse every minute files one request rather than sixty an
      // hour into the inbox a human is supposed to be reading.
      key: `escalation:${run.id}:${health.reason}`,
    };
  }

  const next = run.attempt + 1;
  if (next > policy.maxAttempts) {
    return {
      kind: 'give_up',
      reason: `${run.attempt} attempt${run.attempt === 1 ? '' : 's'} spent on this task; not starting another`,
    };
  }
  const afterMs = backoffMs(run.attempt, policy);
  return {
    kind: 'retry',
    attempt: next,
    afterMs,
    notBefore: (run.endedAt ?? now) + afterMs,
    reason: health.reason,
    key: retryKey(run.id, next),
  };
}

/**
 * Exponential, capped, and with no jitter.
 *
 * Jitter exists to stop many clients retrying in lockstep. There is one fleet
 * on one machine, so there is nothing to spread out — and the determinism is
 * worth more than the property jitter would buy.
 */
export function backoffMs(attemptsSoFar: number, policy: WatchdogPolicy = DEFAULT_WATCHDOG): number {
  const steps = Math.max(0, attemptsSoFar - 1);
  // Bounded before the shift so a large attempt count cannot overflow into a
  // negative delay, which would retry instantly and forever.
  const uncapped = policy.retryBaseMs * 2 ** Math.min(steps, 20);
  return Math.min(policy.retryMaxMs, uncapped);
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}
