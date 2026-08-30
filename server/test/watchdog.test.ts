import type { ChildRun } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import {
  assess,
  backoffMs,
  DEFAULT_WATCHDOG,
  nextAction,
  retryAnchor,
  type RunObservation,
} from '../src/fleet/watchdog.js';
import { dispatchKey } from '../src/fleet/reconcile.js';

/**
 * The watchdog guards a retry loop, which is the one place in the fleet where
 * being wrong costs money on every iteration. So the bounds are pinned harder
 * than the diagnoses: a retry that never stops is a far worse bug than a
 * misnamed symptom.
 */

const NOW = 10_000_000;

function run(over: Partial<ChildRun> = {}): ChildRun {
  return {
    id: 'r1',
    missionId: 'm1',
    taskId: 't1',
    sessionId: 's1',
    agent: 'claude',
    attempt: 1,
    state: 'running',
    startedAt: NOW - 60_000,
    ...over,
  };
}

function observe(over: Partial<RunObservation> = {}): RunObservation {
  return { run: run(), sessionAlive: true, lastActivityAt: NOW - 1000, now: NOW, ...over };
}

describe('assess', () => {
  it('leaves a working run alone', () => {
    expect(assess(observe())).toEqual({ kind: 'healthy' });
  });

  it.each(['stopped', 'failed', 'reported'] as const)('has nothing to say about a %s run', (state) => {
    expect(assess(observe({ run: run({ state }) }))).toEqual({ kind: 'finished' });
  });

  it('calls a run whose session is gone orphaned, not silent', () => {
    // Different symptom, different fix: the shallower diagnosis would send
    // the retry logic down the wrong path.
    const health = assess(observe({ sessionAlive: false, lastActivityAt: NOW - 60 * 60_000 }));
    expect(health.kind).toBe('orphaned');
  });

  it('calls a long-parked approval stuck', () => {
    const health = assess(observe({ pendingApproval: 'Bash', pendingSince: NOW - 6 * 60_000 }));
    expect(health.kind).toBe('stuck');
    expect(health.kind === 'stuck' && health.reason).toContain('Bash');
  });

  it('does not treat a slow human as a fault', () => {
    // Parked for one minute is a person getting coffee, not a stuck fleet.
    expect(assess(observe({ pendingApproval: 'Bash', pendingSince: NOW - 60_000 }))).toEqual({ kind: 'healthy' });
  });

  it('calls a long quiet run silent', () => {
    const health = assess(observe({ lastActivityAt: NOW - 20 * 60_000 }));
    expect(health.kind).toBe('silent');
    expect(health.kind === 'silent' && health.reason).toContain('20m');
  });

  it('lets a long build go quiet without killing it', () => {
    // A watchdog that kills real work is worse than one that reacts late.
    expect(assess(observe({ lastActivityAt: NOW - 10 * 60_000 }))).toEqual({ kind: 'healthy' });
  });

  it('measures silence from the start when nothing has happened yet', () => {
    const health = assess(observe({ run: run({ startedAt: NOW - 30 * 60_000 }), lastActivityAt: undefined }));
    expect(health.kind).toBe('silent');
  });

  it('prefers the orphan diagnosis over a stuck approval', () => {
    const health = assess(observe({ sessionAlive: false, pendingApproval: 'Bash', pendingSince: NOW - 60 * 60_000 }));
    expect(health.kind).toBe('orphaned');
  });
});

describe('nextAction', () => {
  it.each(['healthy', 'finished'] as const)('waits on a %s run', (kind) => {
    expect(nextAction({ kind }, observe())).toEqual({ kind: 'wait' });
  });

  it('escalates a stuck approval instead of retrying it', () => {
    // A retry would park on the same approval at full price, and a child
    // cannot grant itself the capability.
    const action = nextAction({ kind: 'stuck', reason: 'waiting 6m for approval of Bash' }, observe({ run: run() }));
    expect(action.kind).toBe('escalate');
    expect(action.kind === 'escalate' && action.severity).toBe('blocking');
  });

  it('retries a silent run', () => {
    const action = nextAction({ kind: 'silent', reason: 'nothing for 20m' }, observe({ run: run({ attempt: 1 }) }));
    expect(action).toMatchObject({ kind: 'retry', attempt: 2, reason: 'nothing for 20m' });
  });

  it('retries an orphaned run', () => {
    expect(nextAction({ kind: 'orphaned', reason: 'gone' }, observe({ run: run() })).kind).toBe('retry');
  });

  it('gives up once the attempts are spent', () => {
    const action = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: run({ attempt: DEFAULT_WATCHDOG.maxAttempts }) }));
    expect(action.kind).toBe('give_up');
  });

  it('never retries past the limit however high the attempt count got', () => {
    // The bound is on the loop, not on the caller remembering to check.
    for (const attempt of [3, 4, 10, 1000]) {
      expect(nextAction({ kind: 'silent', reason: 'x' }, observe({ run: run({ attempt }) })).kind).toBe('give_up');
    }
  });
});

describe('backoffMs', () => {
  it('doubles per attempt', () => {
    expect(backoffMs(1)).toBe(DEFAULT_WATCHDOG.retryBaseMs);
    expect(backoffMs(2)).toBe(DEFAULT_WATCHDOG.retryBaseMs * 2);
    expect(backoffMs(3)).toBe(DEFAULT_WATCHDOG.retryBaseMs * 4);
  });

  it('is capped', () => {
    expect(backoffMs(50)).toBe(DEFAULT_WATCHDOG.retryMaxMs);
  });

  it('never returns a delay that would retry instantly', () => {
    // A shift overflowing to a negative number would make the retry loop
    // unbounded in the one direction that costs money.
    for (const attempt of [0, 1, 31, 32, 64, 1000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffMs(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(DEFAULT_WATCHDOG.retryMaxMs);
    }
  });

  it('is deterministic, because there is one fleet and nothing to spread out', () => {
    expect(backoffMs(3)).toBe(backoffMs(3));
  });
});

describe('a tick is not a launch', () => {
  it('gives the same run and attempt the same retry key on every tick', () => {
    // Found in review. Every tick over the same silent run returned the same
    // retry, so a pulse each minute would have started a session each minute.
    // A derived key makes repeated ticks collide on one reservation.
    const r = run({ attempt: 1 });
    const first = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: r }));
    const second = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: r }));
    expect(first).toEqual(second);
    // The reconciler's namespace, not a private one: a watchdog retry and a
    // reconciler dispatch of the same task attempt must collide on one
    // reservation, or the keys guarantee nothing.
    expect(first.kind === 'retry' && first.key).toBe(dispatchKey('m1', 't1', 2));
  });

  it('says when the backoff actually expires, not just how long it is', () => {
    // A caller that has not reached notBefore does nothing, which is what
    // makes a fast pulse safe.
    const r = run({ attempt: 1, endedAt: 5_000 });
    const action = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: r }));
    // Silence is only DECLARED after silentAfterMs, so the backoff counts from
    // there. Counting from last activity made every silent deadline already
    // expired, since the backoff caps below that threshold.
    expect(action.kind === 'retry' && action.notBefore).toBe(
      5_000 + DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryBaseMs,
    );
  });

  it('holds the deadline still as the clock advances', () => {
    // Found in review, and it was my own regression: anchoring on `now` meant
    // the deadline moved forward with every tick and was never reached, so a
    // silent run would never be retried at all.
    const r = run({ attempt: 1, startedAt: 1_000 });
    const at = (now: number) => nextAction({ kind: 'silent', reason: 'x' }, observe({ run: r, lastActivityAt: 2_000, now }));
    const first = at(NOW);
    const later = at(NOW + 10 * 60_000);
    expect(first.kind === 'retry' && first.notBefore).toBe(
      2_000 + DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryBaseMs,
    );
    expect(later).toEqual(first);
  });

  it('anchors a silent run on its last activity, not on the tick', () => {
    const action = nextAction(
      { kind: 'silent', reason: 'x' },
      observe({ run: run({ attempt: 1, startedAt: 1_000 }), lastActivityAt: 7_000 }),
    );
    expect(action.kind === 'retry' && action.notBefore).toBe(
      7_000 + DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryBaseMs,
    );
  });

  it('falls back to the start time when a run never did anything', () => {
    const r = run({ attempt: 1, startedAt: 3_000 });
    const action = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: r, lastActivityAt: undefined }));
    expect(action.kind === 'retry' && action.notBefore).toBe(
      3_000 + DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryBaseMs,
    );
  });

  it.each([
    ['ended', { run: run({ attempt: 1, startedAt: 1, endedAt: 9_000 }), lastActivityAt: 5_000 }, 9_000],
    ['silent', { run: run({ attempt: 1, startedAt: 1 }), lastActivityAt: 5_000 }, 5_000],
    ['never active', { run: run({ attempt: 1, startedAt: 4_000 }), lastActivityAt: undefined }, 4_000],
  ])('anchors a %s run on a fixed point in its past', (_label, over, expected) => {
    expect(retryAnchor(observe(over))).toBe(expected);
  });

  it('gives each attempt its own key', () => {
    const a = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: run({ attempt: 1 }) }));
    const b = nextAction({ kind: 'silent', reason: 'x' }, observe({ run: run({ attempt: 2 }) }));
    expect(a.kind === 'retry' && a.key).not.toBe(b.kind === 'retry' && b.key);
  });

  it('files one escalation for a stuck run however often it is ticked', () => {
    const r = run();
    const first = nextAction({ kind: 'stuck', reason: 'waiting 6m for approval of Bash' }, observe({ run: r }));
    const second = nextAction({ kind: 'stuck', reason: 'waiting 6m for approval of Bash' }, observe({ run: r }));
    expect(first.kind === 'escalate' && first.key).toBe(second.kind === 'escalate' && second.key);
  });
});

describe('found by adversarial review', () => {
  it('keys a stuck escalation on the tool, not on a reason that ages', () => {
    // The reason reads "waiting 5m for approval of Bash", then 6m, then 7m.
    // Keying on it produced a new key every tick — sixty distinct
    // "duplicates" an hour, defeating the deduplication it was added for.
    const r = run({ id: 'r1' });
    const keys = [0, 60_000, 120_000, 180_000].map((delta) => {
      const observation = observe({
        run: r,
        pendingApproval: 'Bash',
        pendingSince: NOW - 5 * 60_000,
        now: NOW + delta,
      });
      const action = nextAction(assess(observation), observation);
      return action.kind === 'escalate' ? action.key : `not-escalate:${action.kind}`;
    });
    expect(new Set(keys).size).toBe(1);
  });

  it('treats an approval with no recorded wait as stuck, not as silence', () => {
    // Falling through to the silence check RETRIES it, spending a fresh turn
    // that parks on the same approval. Not knowing how long it has waited is
    // not evidence that it has not waited long.
    const observation = observe({
      run: run({ id: 'r1', startedAt: NOW - 60 * 60_000 }),
      pendingApproval: 'Bash',
      lastActivityAt: NOW - 30 * 60_000,
    });
    const health = assess(observation);
    expect(health.kind).toBe('stuck');
    expect(nextAction(health, observation).kind).toBe('escalate');
  });

  it('terminalizes the run when it gives up, so the slot is released', () => {
    // Otherwise the dead run stays `running` and the reconciler counts its
    // concurrency slot as occupied for the life of the mission.
    const observation = observe({ run: run({ id: 'r1', attempt: 3 }), sessionAlive: false });
    const action = nextAction(assess(observation), observation);
    expect(action).toMatchObject({ kind: 'give_up', terminal: 'failed' });
  });

  it('terminalizes the old run when it retries', () => {
    const observation = observe({ run: run({ id: 'r1', attempt: 1 }), sessionAlive: false });
    expect(nextAction(assess(observation), observation)).toMatchObject({ kind: 'retry', terminal: 'failed' });
  });
});
