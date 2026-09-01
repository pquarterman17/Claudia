/**
 * How the watchdog counts the time before it acts, and whether its thresholds
 * mean anything at all.
 *
 * Split out when watchdog.ts crossed the 400-line ceiling. The seam is the one
 * that module's own doc already names: `assess` answers to OBSERVATION and
 * `nextAction` answers to POLICY, and only the second is allowed to spend
 * another attempt. This is the arithmetic the second half rests on.
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

/**
 * Every threshold this module compares against, and the ordering between them.
 *
 * Finite is not enough. Found in review: a NEGATIVE `retryBaseMs` is perfectly
 * finite and produced `afterMs: -500` with a `notBefore` already in the past —
 * a retry due before the fault it answers. A delay is a positive duration or it
 * is not a delay, and a cap below the base is not a cap.
 */
export function usablePolicy(policy: WatchdogPolicy): boolean {
  const { silentAfterMs, approvalStuckAfterMs, retryBaseMs, retryMaxMs, maxAttempts } = policy;
  if (![silentAfterMs, approvalStuckAfterMs, retryBaseMs, retryMaxMs].every((ms) => Number.isFinite(ms) && ms > 0)) {
    return false;
  }
  if (retryMaxMs < retryBaseMs) return false;
  return Number.isSafeInteger(maxAttempts) && maxAttempts > 0;
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

export function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 1 ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}
