import type { ChildRun, Mission, Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { dispatchKey, reconcile, type Decision, type FleetPolicy } from '../src/fleet/reconcile.js';

/**
 * The property this file exists for is the plan's PR 5 gate: repeated pulses
 * never duplicate a run and never exceed policy. Everything else here is in
 * service of that — a reconciler that is not deterministic will spend money in
 * a loop with nobody watching.
 */

const POLICY: FleetPolicy = { maxChildren: 2, maxAttempts: 3 };

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1',
    name: 'ship it',
    body: '',
    status: 'active',
    watch: 'watching',
    pulseSec: 60,
    maxChildren: 2,
    cwd: '/repo',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    missionId: 'm1',
    title: `task ${seq}`,
    description: '',
    cwd: '/repo',
    status: 'ready',
    priority: 0,
    dependsOn: [],
    acceptance: '',
    createdAt: seq,
    updatedAt: seq,
    ...over,
  };
}

function run(over: Partial<ChildRun> & { taskId: string }): ChildRun {
  return {
    id: `r-${over.taskId}-${over.attempt ?? 1}`,
    missionId: 'm1',
    agent: 'claude',
    attempt: 1,
    state: 'running',
    startedAt: 1,
    ...over,
  };
}

const dispatched = (d: Decision[]): string[] =>
  d.filter((x) => x.kind === 'dispatch').map((x) => x.taskId);

describe('reconcile', () => {
  it('dispatches a ready task with no dependencies', () => {
    const t = task();
    const d = reconcile({ mission: mission(), tasks: [t], runs: [], policy: POLICY });
    expect(dispatched(d)).toEqual([t.id]);
    expect(d[0]).toMatchObject({ attempt: 1 });
  });

  it('never dispatches a task that already has a live run', () => {
    // THE property. A pulse fires every 60 seconds and the task's own status
    // may not have caught up yet; its run has.
    const t = task();
    const d = reconcile({ mission: mission(), tasks: [t], runs: [run({ taskId: t.id })], policy: POLICY });
    expect(dispatched(d)).toEqual([]);
  });

  it('is stable across repeated pulses over unchanged state', () => {
    const tasks = [task({ priority: 1 }), task({ priority: 0 }), task({ priority: 1 })];
    const first = reconcile({ mission: mission(), tasks, runs: [], policy: POLICY });
    const second = reconcile({ mission: mission(), tasks, runs: [], policy: POLICY });
    expect(second).toEqual(first);
  });

  it('respects the child ceiling', () => {
    const busy = [task(), task()];
    const waiting = task();
    const d = reconcile({
      mission: mission(),
      tasks: [...busy, waiting],
      runs: busy.map((t) => run({ taskId: t.id })),
      policy: POLICY,
    });
    expect(dispatched(d)).toEqual([]);
    expect(d.some((x) => x.kind === 'hold' && x.reason.includes('2 of 2'))).toBe(true);
  });

  it('fills only the free slots and says how many are waiting', () => {
    const busy = task();
    const a = task();
    const b = task();
    const d = reconcile({
      mission: mission(),
      tasks: [busy, a, b],
      runs: [run({ taskId: busy.id })],
      policy: POLICY,
    });
    expect(dispatched(d)).toHaveLength(1);
    expect(d.some((x) => x.kind === 'hold' && x.reason.includes('1 task(s) waiting on a free slot'))).toBe(true);
  });

  it('dispatches by priority, then by creation order', () => {
    const late = task({ priority: 0 });
    const early = task({ priority: 0, createdAt: 0 });
    const low = task({ priority: 5 });
    const d = reconcile({
      mission: mission(),
      tasks: [low, late, early],
      runs: [],
      policy: { maxChildren: 2, maxAttempts: 3 },
    });
    expect(dispatched(d)).toEqual([early.id, late.id]);
  });

  it('holds everything while the mission is paused', () => {
    const d = reconcile({ mission: mission({ watch: 'paused' }), tasks: [task()], runs: [], policy: POLICY });
    expect(d).toEqual([{ kind: 'hold', reason: 'mission is paused' }]);
  });

  it.each(['completed', 'archived'] as const)('holds everything while the mission is %s', (status) => {
    const d = reconcile({ mission: mission({ status }), tasks: [task()], runs: [], policy: POLICY });
    expect(d).toEqual([{ kind: 'hold', reason: `mission is ${status}` }]);
  });

  it('blocks a task whose dependency has not been accepted', () => {
    const dep = task({ status: 'running', title: 'the dep' });
    const t = task({ dependsOn: [dep.id] });
    const d = reconcile({ mission: mission(), tasks: [dep, t], runs: [], policy: POLICY });
    expect(dispatched(d)).not.toContain(t.id);
    expect(d).toContainEqual({ kind: 'block', taskId: t.id, reason: 'waiting on "the dep"' });
  });

  it('distinguishes a dependency that failed from one still working', () => {
    // Different asks of the human: one needs patience, the other a decision.
    const dep = task({ status: 'failed', title: 'the dep' });
    const t = task({ dependsOn: [dep.id] });
    const d = reconcile({ mission: mission(), tasks: [dep, t], runs: [], policy: POLICY });
    expect(d).toContainEqual({ kind: 'block', taskId: t.id, reason: 'depends on "the dep", which is failed' });
  });

  it('blocks a task pointing at a dependency that does not exist', () => {
    const t = task({ dependsOn: ['ghost'] });
    const d = reconcile({ mission: mission(), tasks: [t], runs: [], policy: POLICY });
    expect(d).toContainEqual({ kind: 'block', taskId: t.id, reason: 'depends on ghost, which does not exist' });
  });

  it('dispatches once every dependency is accepted', () => {
    const dep = task({ status: 'accepted' });
    const t = task({ dependsOn: [dep.id] });
    expect(dispatched(reconcile({ mission: mission(), tasks: [dep, t], runs: [], policy: POLICY }))).toEqual([t.id]);
  });

  it('unblocks a blocked task whose dependencies are now accepted', () => {
    const dep = task({ status: 'accepted' });
    const t = task({ status: 'blocked', dependsOn: [dep.id] });
    const d = reconcile({ mission: mission(), tasks: [dep, t], runs: [], policy: POLICY });
    expect(d).toContainEqual({ kind: 'unblock', taskId: t.id, reason: 'every dependency is accepted' });
    expect(dispatched(d)).toEqual([t.id]);
  });

  it('does not repeat a block a task is already in', () => {
    // Otherwise every pulse writes the same event forever and the timeline
    // becomes unreadable.
    const dep = task({ status: 'running' });
    const t = task({ status: 'blocked', dependsOn: [dep.id] });
    const d = reconcile({ mission: mission(), tasks: [dep, t], runs: [], policy: POLICY });
    expect(d.filter((x) => x.kind === 'block')).toEqual([]);
  });

  it('names a dependency cycle instead of waiting on it forever', () => {
    // A cycle looks exactly like patience from the outside, and never resolves.
    const a = task();
    const b = task({ dependsOn: [a.id] });
    a.dependsOn = [b.id];
    const d = reconcile({ mission: mission(), tasks: [a, b], runs: [], policy: POLICY });
    expect(dispatched(d)).toEqual([]);
    expect(d).toContainEqual({ kind: 'block', taskId: a.id, reason: 'dependency cycle' });
    expect(d).toContainEqual({ kind: 'block', taskId: b.id, reason: 'dependency cycle' });
  });

  it('finds a task that depends on itself', () => {
    const a = task();
    a.dependsOn = [a.id];
    const d = reconcile({ mission: mission(), tasks: [a], runs: [], policy: POLICY });
    expect(d).toContainEqual({ kind: 'block', taskId: a.id, reason: 'dependency cycle' });
  });

  it('stops retrying once the attempt limit is spent', () => {
    const t = task();
    const runs = [1, 2, 3].map((attempt) => run({ taskId: t.id, attempt, state: 'failed' }));
    const d = reconcile({ mission: mission(), tasks: [t], runs, policy: POLICY });
    expect(dispatched(d)).toEqual([]);
    expect(d).toContainEqual({ kind: 'block', taskId: t.id, reason: '3 attempts spent, limit is 3' });
  });

  it('counts a retry as the next attempt, not a fresh one', () => {
    const t = task();
    const d = reconcile({
      mission: mission(),
      tasks: [t],
      runs: [run({ taskId: t.id, attempt: 1, state: 'failed' })],
      policy: POLICY,
    });
    expect(d[0]).toMatchObject({ kind: 'dispatch', attempt: 2, reason: 'retry 2 of 3' });
  });

  it("ignores tasks in states that are not the reconciler's business", () => {
    const states = ['proposed', 'running', 'reported', 'accepted', 'failed', 'cancelled'] as const;
    const d = reconcile({
      mission: mission(),
      tasks: states.map((status) => task({ status })),
      runs: [],
      policy: POLICY,
    });
    expect(d).toEqual([{ kind: 'hold', reason: 'no task is ready' }]);
  });

  it('says why nothing happened when there is nothing to do', () => {
    const d = reconcile({ mission: mission(), tasks: [], runs: [], policy: POLICY });
    expect(d).toEqual([{ kind: 'hold', reason: 'no task is ready' }]);
  });
});

describe('idempotent execution, which determinism alone is not', () => {
  it('gives the same task and attempt the same reservation key on every pulse', () => {
    // Found in review. Two pulses reading the same snapshot before either run
    // is recorded both dispatch — correctly, nothing changed. The key is what
    // lets the store reject the second inside the transaction that writes the
    // run, so only one session is ever launched.
    const t = task();
    const first = reconcile({ mission: mission(), tasks: [t], runs: [], policy: POLICY });
    const second = reconcile({ mission: mission(), tasks: [t], runs: [], policy: POLICY });
    const keyOf = (d: Decision[]) => d.find((x) => x.kind === 'dispatch')?.key;
    expect(keyOf(first)).toBe(keyOf(second));
    expect(keyOf(first)).toBe(dispatchKey('m1', t.id, 1));
  });

  it('gives a retry a different key from the attempt it replaces', () => {
    const t = task();
    const fresh = reconcile({ mission: mission(), tasks: [t], runs: [], policy: POLICY });
    const retry = reconcile({
      mission: mission(),
      tasks: [t],
      runs: [run({ taskId: t.id, attempt: 1, state: 'failed' })],
      policy: POLICY,
    });
    const keyOf = (d: Decision[]) => d.find((x) => x.kind === 'dispatch')?.key;
    expect(keyOf(retry)).not.toBe(keyOf(fresh));
  });

  it('never reuses a key across missions', () => {
    expect(dispatchKey('m1', 't1', 1)).not.toBe(dispatchKey('m2', 't1', 1));
  });
});

describe('counting', () => {
  it('proposes the attempt after the highest one spent, not after the row count', () => {
    // Found in review: a history of attempts 1 and 3 is two rows, so counting
    // them proposed attempt 3 — already spent, colliding with the run that
    // spent it. Rows go missing; the number on the run does not.
    const t = task();
    const runs = [
      run({ taskId: t.id, attempt: 1, state: 'failed' }),
      run({ taskId: t.id, attempt: 3, state: 'failed' }),
    ];
    const d = reconcile({ mission: mission(), tasks: [t], runs, policy: { maxChildren: 2, maxAttempts: 5 } });
    expect(d.find((x) => x.kind === 'dispatch')).toMatchObject({ attempt: 4 });
  });

  it('stops at the limit by the highest attempt, not the row count', () => {
    const t = task();
    const runs = [run({ taskId: t.id, attempt: 3, state: 'failed' })];
    const d = reconcile({ mission: mission(), tasks: [t], runs, policy: POLICY });
    expect(d.some((x) => x.kind === 'dispatch')).toBe(false);
  });

  it('counts capacity in runs, so two runs on one task occupy two slots', () => {
    // Found in review: duplicate active runs collapsed to one busy slot, so
    // the fleet believed it had room it did not have — and duplicates are
    // exactly the state a half-recovered mission is in.
    const busy = task();
    const waiting = task();
    const runs = [
      run({ taskId: busy.id, attempt: 1 }),
      run({ taskId: busy.id, attempt: 2 }),
    ];
    const d = reconcile({ mission: mission(), tasks: [busy, waiting], runs, policy: POLICY });
    expect(d.some((x) => x.kind === 'dispatch')).toBe(false);
    expect(d.some((x) => x.kind === 'hold' && x.reason.includes('2 of 2'))).toBe(true);
  });
});

describe('budgets', () => {
  it('stops dispatching once the time budget is spent', () => {
    // Found in review: budgetSec and budgetTokens were persisted, shown, and
    // read by nothing — a limit that enforces nothing is a promise the app is
    // quietly breaking.
    const d = reconcile({
      mission: mission({ budgetSec: 600 }),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: 600, tokens: 0 },
    });
    expect(d).toEqual([{ kind: 'hold', reason: 'spent its 600s budget' }]);
  });

  it('stops dispatching once the token budget is spent', () => {
    const d = reconcile({
      mission: mission({ budgetTokens: 1_000 }),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: 0, tokens: 1_000 },
    });
    expect(d[0]).toMatchObject({ kind: 'hold' });
    expect(d[0]?.kind === 'hold' && d[0].reason).toContain('token');
  });

  it('keeps going while inside both budgets', () => {
    const d = reconcile({
      mission: mission({ budgetSec: 600, budgetTokens: 1_000 }),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: 599, tokens: 999 },
    });
    expect(d.some((x) => x.kind === 'dispatch')).toBe(true);
  });

  it('reports being out of budget differently from being busy', () => {
    // One clears itself when a run finishes; the other does not clear until a
    // human raises the limit.
    const d = reconcile({
      mission: mission({ budgetSec: 1 }),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: 99, tokens: 0 },
    });
    expect(d[0]?.kind === 'hold' && d[0].reason).not.toContain('busy');
  });

  it('dispatches normally when no budget is set', () => {
    const d = reconcile({
      mission: mission(),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: 1_000_000, tokens: 1_000_000 },
    });
    expect(d.some((x) => x.kind === 'dispatch')).toBe(true);
  });
});

describe('records from other missions', () => {
  it("never dispatches another mission's task", () => {
    // A caller passing a broad query would otherwise start work that does not
    // belong to this mission, and nothing downstream would call it an error.
    const foreign = task({ missionId: 'm2' });
    const d = reconcile({ mission: mission(), tasks: [foreign], runs: [], policy: POLICY });
    expect(d).toEqual([{ kind: 'hold', reason: 'no task is ready' }]);
  });

  it("does not let another mission's runs consume this one's capacity", () => {
    const mine = task();
    const d = reconcile({
      mission: mission(),
      tasks: [mine],
      runs: [run({ taskId: 'someone-else', missionId: 'm2' }), run({ taskId: 'other', missionId: 'm2' })],
      policy: POLICY,
    });
    expect(d.some((x) => x.kind === 'dispatch')).toBe(true);
  });

  it('does not count a foreign run when numbering attempts', () => {
    const mine = task();
    const d = reconcile({
      mission: mission(),
      tasks: [mine],
      runs: [run({ taskId: mine.id, missionId: 'm2', attempt: 9, state: 'failed' })],
      policy: POLICY,
    });
    expect(d.find((x) => x.kind === 'dispatch')).toMatchObject({ attempt: 1 });
  });
});

describe('found by adversarial review', () => {
  it('does not unblock and re-block the same task on every pulse', () => {
    // A task blocked because its attempts are spent was unblocked (its
    // dependencies are fine) and immediately re-blocked — two events a
    // minute, forever, describing a state that never changed.
    const t = task({ status: 'blocked' });
    const runs = [1, 2, 3].map((attempt) => run({ taskId: t.id, attempt, state: 'failed' }));
    const d = reconcile({ mission: mission(), tasks: [t], runs, policy: POLICY });
    expect(d.filter((x) => x.kind === 'unblock')).toEqual([]);
    expect(d.filter((x) => x.kind === 'block')).toEqual([]);
    expect(d.some((x) => x.kind === 'dispatch')).toBe(false);
  });

  it('still unblocks a task that can actually run once unblocked', () => {
    // The fix must not silence the legitimate case.
    const dep = task({ status: 'accepted' });
    const t = task({ status: 'blocked', dependsOn: [dep.id] });
    const d = reconcile({ mission: mission(), tasks: [dep, t], runs: [], policy: POLICY });
    expect(d.some((x) => x.kind === 'unblock' && x.taskId === t.id)).toBe(true);
    expect(d.some((x) => x.kind === 'dispatch' && x.taskId === t.id)).toBe(true);
  });

  it('says nothing new about a task already blocked on spent attempts', () => {
    const t = task({ status: 'blocked' });
    const runs = [run({ taskId: t.id, attempt: 3, state: 'failed' })];
    const first = reconcile({ mission: mission(), tasks: [t], runs, policy: POLICY });
    const second = reconcile({ mission: mission(), tasks: [t], runs, policy: POLICY });
    expect(first).toEqual(second);
    expect(first).toEqual([{ kind: 'hold', reason: 'no task is ready' }]);
  });
});

describe('found by adversarial audit', () => {
  it('honours the ceiling the human set on the mission, not just the server policy', () => {
    // `mission.maxChildren` was persisted, bounded on the way in by the store,
    // and read by no production code: a mission set to one child dispatched
    // eight. The same shape `overBudget` already has a comment about — visible
    // in the UI, settable by a human, enforcing nothing.
    const tasks = Array.from({ length: 8 }, () => task());
    const decisions = reconcile({
      mission: mission({ maxChildren: 1 }),
      tasks,
      runs: [],
      policy: { maxChildren: 8, maxAttempts: 3 },
    });
    expect(decisions.filter((d) => d.kind === 'dispatch')).toHaveLength(1);
  });

  it('takes the lower of the two ceilings, whichever way round they are', () => {
    const tasks = Array.from({ length: 8 }, () => task());
    const byPolicy = reconcile({
      mission: mission({ maxChildren: 8 }),
      tasks,
      runs: [],
      policy: { maxChildren: 2, maxAttempts: 3 },
    });
    expect(byPolicy.filter((d) => d.kind === 'dispatch')).toHaveLength(2);
  });

  it('will not dispatch on a spend it cannot read', () => {
    // NaN >= x is false, so an unreadable number switched both budgets off
    // silently. `tokens` is summed from model usage, where one missing field
    // produces NaN — the fleet would have run to exhaustion with a ceiling set.
    for (const spend of [
      { elapsedSec: Number.NaN, tokens: 0 },
      { elapsedSec: 0, tokens: Number.NaN },
    ]) {
      const decisions = reconcile({
        mission: mission({ budgetSec: 600, budgetTokens: 1000 }),
        tasks: [task()],
        runs: [],
        policy: POLICY,
        spend,
      });
      expect(decisions.filter((d) => d.kind === 'dispatch')).toHaveLength(0);
      expect(decisions[0]).toMatchObject({ kind: 'hold' });
      expect(decisions[0]?.kind === 'hold' && decisions[0].reason).toMatch(/cannot read/);
    }
  });

  it('says which of the two it could not read', () => {
    const decisions = reconcile({
      mission: mission({ budgetTokens: 1000 }),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: Number.NaN, tokens: Number.NaN },
    });
    // Only the token budget is set, so only the token spend is load-bearing:
    // an unreadable elapsed time with no time budget is not a reason to stop.
    expect(decisions[0]?.kind === 'hold' && decisions[0].reason).toContain('token spend');
    expect(decisions[0]?.kind === 'hold' && decisions[0].reason).not.toContain('elapsed');
  });

  it('still dispatches when the unreadable number is not one being enforced', () => {
    const decisions = reconcile({
      mission: mission(),
      tasks: [task()],
      runs: [],
      policy: POLICY,
      spend: { elapsedSec: Number.NaN, tokens: Number.NaN },
    });
    expect(decisions.filter((d) => d.kind === 'dispatch')).toHaveLength(1);
  });
});

describe('found reviewing my own fix', () => {
  it.each([
    ['NaN', Number.NaN],
    ['absent', undefined as unknown as number],
  ])('holds, with a reason, when the mission ceiling is %s', (_label, maxChildren) => {
    // The commit that started reading mission.maxChildren introduced this:
    // Math.min(NaN, 2) is NaN, NaN <= 0 is false, and slice(0, NaN) is empty,
    // so the reconciler returned NO decisions at all. Not a dispatch, not even
    // a hold — the fleet did nothing and said nothing about why, which this
    // file's own design calls out as indistinguishable from being broken. The
    // same commit guarded a non-finite budget and left this untouched.
    const decisions = reconcile({
      mission: mission({ maxChildren }),
      tasks: [task(), task()],
      runs: [],
      policy: POLICY,
    });
    expect(decisions).not.toEqual([]);
    expect(decisions.filter((d) => d.kind === 'dispatch')).toHaveLength(0);
    expect(decisions[0]?.kind === 'hold' && decisions[0].reason).toMatch(/cannot read how many children/);
  });

  it('still dispatches on a readable ceiling either side of the minimum', () => {
    for (const [missionCeiling, policyCeiling, expected] of [
      [1, 8, 1],
      [8, 2, 2],
    ] as const) {
      const decisions = reconcile({
        mission: mission({ maxChildren: missionCeiling }),
        tasks: [task(), task(), task()],
        runs: [],
        policy: { maxChildren: policyCeiling, maxAttempts: 3 },
      });
      expect(decisions.filter((d) => d.kind === 'dispatch')).toHaveLength(expected);
    }
  });
});
