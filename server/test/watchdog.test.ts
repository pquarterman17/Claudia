import { isLegalRoute, TASK_TRANSITIONS, type ChildRun } from '@claudia/shared';
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

/**
 * An observation whose retry is genuinely DUE.
 *
 * `observe()` puts the last activity one second ago, which is a run that has
 * not been quiet long enough for anything to be wrong with it. Handing that to
 * `nextAction` alongside a synthetic `silent` health used to be harmless
 * because nothing looked at the clock; now that a retry is withheld until its
 * backoff expires, a fixture like that is asking "what would you do about a
 * fault that has not happened yet" and correctly gets `backoff`. Every test
 * that means "the retry is due" says so here.
 */
function due(over: Partial<RunObservation> = {}): RunObservation {
  const quiet = DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryMaxMs + 60_000;
  return observe({ run: run({ startedAt: NOW - quiet }), lastActivityAt: NOW - quiet, ...over });
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
    const action = nextAction(
      { kind: 'stuck', reason: 'waiting 6m for approval of Bash', tool: 'Bash' },
      observe({ run: run() }),
    );
    expect(action.kind).toBe('escalate');
    expect(action.kind === 'escalate' && action.severity).toBe('blocking');
    // `tool` was missing here until the tests were typechecked, and the key it
    // produced was 'escalation:r1:undefined' — a test passing while pinning a
    // dedup key that deduplicates every stuck run onto one inbox row.
    expect(action.kind === 'escalate' && action.key).toBe('escalation:r1:Bash');
  });

  it('retries a silent run', () => {
    const action = nextAction({ kind: 'silent', reason: 'nothing for 20m' }, due({ run: run({ attempt: 1 }) }));
    expect(action).toMatchObject({ kind: 'retry', attempt: 2, reason: 'nothing for 20m' });
  });

  it('retries an orphaned run', () => {
    expect(nextAction({ kind: 'orphaned', reason: 'gone' }, due()).kind).toBe('retry');
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
    const r = run({ attempt: 1, startedAt: NOW - 10_000_000 });
    const first = nextAction({ kind: 'silent', reason: 'x' }, due({ run: r }));
    const second = nextAction({ kind: 'silent', reason: 'x' }, due({ run: r }));
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
    const a = nextAction({ kind: 'silent', reason: 'x' }, due({ run: run({ attempt: 1 }) }));
    const b = nextAction({ kind: 'silent', reason: 'x' }, due({ run: run({ attempt: 2 }) }));
    expect(a.kind === 'retry' && a.key).not.toBe(b.kind === 'retry' && b.key);
  });

  it('files one escalation for a stuck run however often it is ticked', () => {
    const r = run();
    const stuck = { kind: 'stuck', reason: 'waiting 6m for approval of Bash', tool: 'Bash' } as const;
    const first = nextAction(stuck, observe({ run: r }));
    const second = nextAction(stuck, observe({ run: r }));
    expect(first.kind === 'escalate' && first.key).toBe(second.kind === 'escalate' && second.key);
    // And two runs stuck on the same tool are still two rows a human must see.
    const other = nextAction(stuck, observe({ run: run({ id: 'r2' }) }));
    expect(first.kind === 'escalate' && first.key).not.toBe(other.kind === 'escalate' && other.key);
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
    const observation = due({ run: run({ id: 'r1', attempt: 1 }), sessionAlive: false });
    expect(nextAction(assess(observation), observation)).toMatchObject({ kind: 'retry', terminal: 'failed' });
  });
});

describe('found by adversarial audit', () => {
  it('says what becomes of the TASK when it gives up, not only the run', () => {
    // Applying give_up used to leave the task `running` with its run `failed`.
    // reconcile only looks at ready/blocked and the watchdog only looks at live
    // runs, so nothing in the fleet could move that task again for the life of
    // the process — the same wedge `terminal` closed, one row over.
    const action = nextAction(
      { kind: 'silent', reason: 'nothing for 20m' },
      observe({ run: run({ attempt: 3 }), attemptsSpent: 3 }),
      { ...DEFAULT_WATCHDOG, maxAttempts: 3 },
    );
    expect(action).toMatchObject({ kind: 'give_up', terminal: 'failed', task: { to: 'failed', path: ['failed'] } });
  });

  it('puts a retried task back where the reconciler will find it', () => {
    // The retry reserves in the reconciler's key namespace, so the reconciler
    // is what dispatches it — and it only ever dispatches ready and blocked.
    const action = nextAction({ kind: 'silent', reason: 'nothing for 20m' }, due());
    expect(action).toMatchObject({ kind: 'retry', task: { to: 'ready', path: ['failed', 'ready'] } });
  });

  it('routes both through failed, which is what the contract allows from running', () => {
    // Not decoration: `running -> ready` is not an edge, so a decision naming
    // it is one the store refuses.
    for (const outcome of [
      nextAction({ kind: 'silent', reason: 'x' }, due()),
      nextAction({ kind: 'silent', reason: 'x' }, due({ run: run({ attempt: 9 }), attemptsSpent: 9 })),
    ]) {
      const task = 'task' in outcome ? outcome.task : undefined;
      expect(task).toBeDefined();
      expect(isLegalRoute('running', task?.path ?? [], TASK_TRANSITIONS)).toBe(true);
      expect(task?.path.at(-1)).toBe(task?.to);
    }
  });

  it('calls a run silent when it cannot tell how long it has been quiet', () => {
    // NaN >= x is false, so an unreadable timestamp made every run healthy
    // forever: the one fault this module exists to catch, silenced by the
    // arithmetic that catches it.
    expect(assess(observe({ lastActivityAt: Number.NaN })).kind).toBe('silent');
    expect(assess(observe({ now: Number.NaN })).kind).toBe('silent');
    // A run with no recorded activity falls back to startedAt, which must also
    // be readable.
    expect(assess(observe({ run: run({ startedAt: Number.NaN }), lastActivityAt: undefined })).kind).toBe('silent');
  });
});

describe('found reviewing my own fix', () => {
  it('withholds a retry that is not due yet, and says so rather than looking healthy', () => {
    // The backoff lives here; the dispatch lives in the reconciler; the only
    // thing joining them is a task status, which carries no timing. So emitting
    // `retry` early with a `task` route to apply meant the reconciler
    // dispatched on its next pulse whatever notBefore said — measured at 30s
    // early. Nothing downstream can honour a deadline it is never told about.
    const quiet = DEFAULT_WATCHDOG.silentAfterMs + 1;
    const observation = observe({ run: run({ startedAt: NOW - quiet }), lastActivityAt: NOW - quiet });
    const action = nextAction(assess(observation), observation);
    expect(action.kind).toBe('backoff');
    if (action.kind !== 'backoff') return;
    expect(action.until).toBeGreaterThan(NOW);
    expect(action.attempt).toBe(2);
    // Carries nothing to apply: no task route, no terminal state.
    expect(action).not.toHaveProperty('task');
    expect(action).not.toHaveProperty('terminal');
  });

  it('is not the same answer as a healthy run', () => {
    // Collapsing the two would hide a failing run behind a healthy-looking
    // tile for the length of the backoff.
    expect(nextAction({ kind: 'healthy' }, observe()).kind).toBe('wait');
  });

  it('emits the retry once the backoff has actually expired', () => {
    const quiet = DEFAULT_WATCHDOG.silentAfterMs + 1;
    const at = (now: number) => {
      const observation = observe({ run: run({ startedAt: NOW - quiet }), lastActivityAt: NOW - quiet, now });
      return nextAction(assess(observation), observation);
    };
    const held = at(NOW);
    expect(held.kind).toBe('backoff');
    if (held.kind !== 'backoff') return;
    expect(at(held.until - 1).kind).toBe('backoff');
    expect(at(held.until).kind).toBe('retry');
  });

  it('still gives up immediately, because giving up is not a thing to wait for', () => {
    const quiet = DEFAULT_WATCHDOG.silentAfterMs + 1;
    const observation = observe({
      run: run({ attempt: DEFAULT_WATCHDOG.maxAttempts, startedAt: NOW - quiet }),
      lastActivityAt: NOW - quiet,
    });
    expect(nextAction(assess(observation), observation).kind).toBe('give_up');
  });
});

describe('the backoff belongs to the task, not to one run', () => {
  it('delays by the attempts the TASK has spent, not the attempt this row happens to hold', () => {
    // A retry announcing "attempt 5" used to carry backoffMs(1) — 30 seconds —
    // because `next` counted over the task and the delay counted over the run.
    // The exponential backoff was shortest for exactly the runs that had failed
    // most, in the one place the module says every iteration costs money.
    const quiet = DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryMaxMs + 60_000;
    const observation = observe({
      run: run({ attempt: 1, startedAt: NOW - quiet }),
      lastActivityAt: NOW - quiet,
      attemptsSpent: 4,
    });
    const action = nextAction({ kind: 'silent', reason: 'x' }, observation, {
      ...DEFAULT_WATCHDOG,
      maxAttempts: 9,
    });
    expect(action.kind).toBe('retry');
    if (action.kind !== 'retry') return;
    expect(action.attempt).toBe(5);
    expect(action.afterMs).toBe(backoffMs(4));
    expect(action.afterMs).not.toBe(backoffMs(1));
  });

  it('is unchanged when the run is the only attempt the task has had', () => {
    const quiet = DEFAULT_WATCHDOG.silentAfterMs + DEFAULT_WATCHDOG.retryMaxMs + 60_000;
    const observation = observe({ run: run({ attempt: 1, startedAt: NOW - quiet }), lastActivityAt: NOW - quiet });
    const action = nextAction({ kind: 'silent', reason: 'x' }, observation);
    expect(action.kind === 'retry' && action.afterMs).toBe(backoffMs(1));
  });
});

describe('numeric inputs the review found still failing open', () => {
  it('escalates rather than emitting a retry for attempt NaN', () => {
    // Reproduced from the review: an executable retry announcing attempt NaN,
    // afterMs NaN, notBefore NaN and the reservation key dispatch:m:t:NaN —
    // and since `now < NaN` is false it sailed past the backoff gate too.
    const action = nextAction(
      { kind: 'orphaned', reason: 'gone' },
      observe({ attemptsSpent: Number.NaN, sessionAlive: false }),
    );
    expect(action.kind).toBe('escalate');
    if (action.kind !== 'escalate') return;
    expect(action.severity).toBe('blocking');
    expect(action.key).not.toContain('NaN');
  });

  it('does not read a parked approval with an unreadable timestamp as healthy', () => {
    // `waited >= threshold` is false for NaN, so it fell through to healthy —
    // when the branch below already treats "parked, with no record of when" as
    // stuck, for the stated reason that not knowing how long it has waited is
    // not evidence that it has not waited long.
    const health = assess(observe({ pendingApproval: 'Bash', pendingSince: Number.NaN }));
    expect(health.kind).toBe('stuck');
  });

  it('does not call every run healthy when the policy itself is unreadable', () => {
    for (const bad of [
      { ...DEFAULT_WATCHDOG, silentAfterMs: Number.NaN },
      { ...DEFAULT_WATCHDOG, approvalStuckAfterMs: Number.NaN },
      { ...DEFAULT_WATCHDOG, retryBaseMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(assess(observe(), bad).kind).not.toBe('healthy');
    }
  });
});

describe('validation composes, because the two entry points are separate', () => {
  it.each([
    ['silentAfterMs NaN', { silentAfterMs: Number.NaN }],
    ['retryBaseMs NaN', { retryBaseMs: Number.NaN }],
    ['retryBaseMs negative', { retryBaseMs: -500 }],
    ['retryMaxMs below the base', { retryBaseMs: 60_000, retryMaxMs: 1_000 }],
    ['maxAttempts NaN', { maxAttempts: Number.NaN }],
  ])('escalates rather than retrying when the policy says %s', (_label, over) => {
    // `assess` validating the policy proves nothing about `nextAction`: they
    // are separate entry points a caller composes. With an unusable policy every
    // arithmetic result is NaN, and `now < NaN` is false — so the backoff gate
    // this branch added waved through an executable retry announcing a delay it
    // had never computed. A negative retryBaseMs is finite and produced
    // afterMs: -500, due before the fault it answers.
    const action = nextAction({ kind: 'silent', reason: 'x' }, due(), { ...DEFAULT_WATCHDOG, ...over });
    expect(action.kind).toBe('escalate');
  });

  it('escalates rather than retrying when the clock is unreadable', () => {
    expect(nextAction({ kind: 'silent', reason: 'x' }, due({ now: Number.NaN })).kind).toBe('escalate');
  });

  it('does not call a parked approval healthy when it cannot read the clock', () => {
    // The guard for this existed on the silent path and was reachable through
    // the approval branch instead, where `NaN >= threshold` is false.
    const health = assess(observe({ now: Number.NaN, pendingApproval: 'Bash', pendingSince: NOW - 1 }));
    expect(health.kind).not.toBe('healthy');
  });

  it.each([
    ['last activity', { run: run({ attempt: 1, startedAt: NOW - 60_000 }), lastActivityAt: Number.NaN }],
    ['end time', { run: run({ attempt: 1, endedAt: Number.NaN }), lastActivityAt: NOW - 60_000 }],
    ['start time', { run: run({ attempt: 1, startedAt: Number.NaN }), lastActivityAt: undefined }],
  ])('escalates rather than retrying when it cannot read the %s', (_label, over) => {
    // The third input to the same arithmetic, and the last one still taken on
    // trust. `??` falls back on absence, not on nonsense, so a NaN
    // `lastActivityAt` was selected over a perfectly good `startedAt`; the
    // retry that came back announced `notBefore: NaN` and cleared the
    // `now < notBefore` gate, because every comparison with NaN is false.
    const action = nextAction({ kind: 'silent', reason: 'x' }, due(over));
    expect(action.kind).toBe('escalate');
    if (action.kind !== 'escalate') return;
    expect(action.severity).toBe('blocking');
    expect(action.key).not.toContain('NaN');
  });

  it('does not quietly count the backoff from an earlier anchor instead', () => {
    // The tempting repair — fall through to the next candidate — is not one.
    // Each is EARLIER than the one that could not be read, so substituting it
    // shortens the backoff by an unknown amount, which is the retry loop
    // spending sooner than policy says. `undefined` says so out loud.
    expect(retryAnchor(due({ lastActivityAt: Number.NaN }))).toBeUndefined();
  });

  it('still gives up rather than escalating when the attempts are gone', () => {
    // Order matters: with nothing left to spend there is no backoff to count,
    // so an unreadable clock in the run's past must not turn a finished task
    // into a page for a human.
    const spent = DEFAULT_WATCHDOG.maxAttempts;
    const action = nextAction(
      { kind: 'silent', reason: 'x' },
      due({ run: run({ attempt: spent, startedAt: Number.NaN }), lastActivityAt: Number.NaN }),
    );
    expect(action.kind).toBe('give_up');
  });
});
