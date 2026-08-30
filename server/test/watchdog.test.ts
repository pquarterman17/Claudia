import type { ChildRun } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import {
  assess,
  backoffMs,
  DEFAULT_WATCHDOG,
  nextAction,
  retryKey,
  type RunObservation,
} from '../src/fleet/watchdog.js';

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
    expect(nextAction({ kind }, run())).toEqual({ kind: 'wait' });
  });

  it('escalates a stuck approval instead of retrying it', () => {
    // A retry would park on the same approval at full price, and a child
    // cannot grant itself the capability.
    const action = nextAction({ kind: 'stuck', reason: 'waiting 6m for approval of Bash' }, run());
    expect(action.kind).toBe('escalate');
    expect(action.kind === 'escalate' && action.severity).toBe('blocking');
  });

  it('retries a silent run', () => {
    const action = nextAction({ kind: 'silent', reason: 'nothing for 20m' }, run({ attempt: 1 }));
    expect(action).toMatchObject({ kind: 'retry', attempt: 2, reason: 'nothing for 20m' });
  });

  it('retries an orphaned run', () => {
    expect(nextAction({ kind: 'orphaned', reason: 'gone' }, run()).kind).toBe('retry');
  });

  it('gives up once the attempts are spent', () => {
    const action = nextAction({ kind: 'silent', reason: 'x' }, run({ attempt: DEFAULT_WATCHDOG.maxAttempts }));
    expect(action.kind).toBe('give_up');
  });

  it('never retries past the limit however high the attempt count got', () => {
    // The bound is on the loop, not on the caller remembering to check.
    for (const attempt of [3, 4, 10, 1000]) {
      expect(nextAction({ kind: 'silent', reason: 'x' }, run({ attempt })).kind).toBe('give_up');
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
    const first = nextAction({ kind: 'silent', reason: 'x' }, r);
    const second = nextAction({ kind: 'silent', reason: 'x' }, r);
    expect(first).toEqual(second);
    expect(first.kind === 'retry' && first.key).toBe(retryKey('r1', 2));
  });

  it('says when the backoff actually expires, not just how long it is', () => {
    // A caller that has not reached notBefore does nothing, which is what
    // makes a fast pulse safe.
    const r = run({ attempt: 1, endedAt: 5_000 });
    const action = nextAction({ kind: 'silent', reason: 'x' }, r);
    expect(action.kind === 'retry' && action.notBefore).toBe(5_000 + DEFAULT_WATCHDOG.retryBaseMs);
  });

  it('gives each attempt its own key', () => {
    const a = nextAction({ kind: 'silent', reason: 'x' }, run({ attempt: 1 }));
    const b = nextAction({ kind: 'silent', reason: 'x' }, run({ attempt: 2 }));
    expect(a.kind === 'retry' && a.key).not.toBe(b.kind === 'retry' && b.key);
  });

  it('files one escalation for a stuck run however often it is ticked', () => {
    const r = run();
    const first = nextAction({ kind: 'stuck', reason: 'waiting 6m for approval of Bash' }, r);
    const second = nextAction({ kind: 'stuck', reason: 'waiting 6m for approval of Bash' }, r);
    expect(first.kind === 'escalate' && first.key).toBe(second.kind === 'escalate' && second.key);
  });
});
