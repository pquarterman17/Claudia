import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { pulseMission, type SessionFacts } from '../src/fleet/pulse.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The budget that was persisted, settable, and enforcing nothing.
 *
 * `overBudget` in the reconciler is careful and complete — it even refuses to
 * dispatch on an unreadable spend, on the fleet's standing bias that an
 * unknown is not permission. `reconcile` takes `spend` as optional and
 * `pulseMission` never passed one, so the very first line of that function,
 * `if (!spend) return undefined`, meant every mission was under budget forever.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-budgets-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const NO_SESSIONS = (): ReadonlyMap<string, SessionFacts> => new Map();
const POLICY = { maxChildren: 4, maxAttempts: 3 };

let counter = 0;
function mission(over: { budgetSec?: number; budgetTokens?: number } = {}) {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);
  const created = store.missions.create({ name: 'm', body: '', cwd: '/repo', ...over });
  if (!created.ok) throw new Error(created.message);
  const watched = store.missions.setWatch(created.value.id, 'watching');
  if (!watched.ok) throw new Error(watched.message);
  return { store, mission: watched.value };
}

function readyTask(store: FleetStore, missionId: string) {
  const task = store.tasks.create({ missionId, title: 't', description: '', cwd: '/repo' });
  if (!task.ok) throw new Error(task.message);
  const ready = store.tasks.setStatus(task.value.id, 'ready');
  if (!ready.ok) throw new Error(ready.message);
  return ready.value;
}

/** A finished run, so the mission has a start time to measure elapsed from. */
function pastRun(store: FleetStore, missionId: string, taskId: string, startedAt: number) {
  const run = store.runs.create({ missionId, taskId, agent: 'claude', attempt: 1, state: 'dispatched' });
  if (!run.ok) throw new Error(run.message);
  store.db.prepare('UPDATE child_runs SET started_at = ? WHERE id = ?').run(startedAt, run.value.id);
  const ended = store.runs.setState(run.value.id, 'failed', { terminalReason: 'for the fixture' });
  if (!ended.ok) throw new Error(ended.message);
  return run.value;
}

function kinds(store: FleetStore, missionId: string): string[] {
  const events = store.events.sinceForMission(missionId);
  if (!events.ok) throw new Error(events.message);
  return events.value.map((e) => e.kind);
}

describe('a mission with a time budget', () => {
  it('still dispatches while it has time left', async () => {
    const { store, mission: m } = mission({ budgetSec: 3600 });
    const first = readyTask(store, m.id);
    // Started a minute ago, against an hour's budget.
    pastRun(store, m.id, first.id, Date.now() - 60_000);
    const second = readyTask(store, m.id);
    void second;

    const launched: string[] = [];
    const result = await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    expect(result?.launched).toBeGreaterThan(0);
  });

  it('stops dispatching once the budget is spent', async () => {
    // The whole point. Before this, `budgetSec` was a number in the database
    // that no code path ever compared anything against.
    const { store, mission: m } = mission({ budgetSec: 60 });
    const first = readyTask(store, m.id);
    pastRun(store, m.id, first.id, Date.now() - 7_200_000);
    readyTask(store, m.id);

    const launched: string[] = [];
    const result = await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    expect(launched).toEqual([]);
    expect(result?.launched).toBe(0);
    // And it says so, rather than going quiet. A stalled mission with nothing
    // in its log is indistinguishable from a broken one.
    expect(kinds(store, m.id)).toContain('mission_held');
    const events = store.events.sinceForMission(m.id);
    if (!events.ok) throw new Error(events.message);
    const held = events.value.find((e) => e.kind === 'mission_held');
    expect(JSON.stringify(held?.payload)).toContain('60s budget');
    // About the mission, not about any one task.
    expect(held?.taskId).toBeUndefined();
  });

  it('measures from the first run, not from when the mission was written down', async () => {
    // A mission described a week ago and never dispatched has spent nothing.
    // Charging it for its own age would kill it the moment it was started.
    const { store, mission: m } = mission({ budgetSec: 60 });
    readyTask(store, m.id);
    store.db.prepare('UPDATE missions SET created_at = ? WHERE id = ?').run(Date.now() - 604_800_000, m.id);
    const aged = store.missions.get(m.id);
    if (!aged.ok || !aged.value) throw new Error('the mission went missing');

    const launched: string[] = [];
    await pulseMission(aged.value, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    // One ready task, and a mission whose age is not its spend.
    expect(launched).toHaveLength(1);
  });
});

describe('a mission with a token budget', () => {
  /**
   * This used to assert the opposite, and correctly: token spend lived on a
   * session, a session that ended took its counts with it, and `spendOf`
   * answered NaN — so `overBudget` held every mission with a token budget on
   * its first pulse, permanently. Settable, visible, and enforcing a stop
   * rather than a bound, which is the worst shape a limit can take.
   *
   * The counts are on the run rows now, so the budget is a budget.
   */
  it('dispatches while the runs it has paid for are still under the budget', async () => {
    const { store, mission: m } = mission({ budgetTokens: 1_000_000 });
    const spent = readyTask(store, m.id);
    const past = pastRun(store, m.id, spent.id, Date.now() - 60_000);
    const recorded = store.runs.recordTokens(past.id, 400_000);
    if (!recorded.ok) throw new Error(recorded.message);
    readyTask(store, m.id);

    const launched: string[] = [];
    await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    // Both ready tasks: the one whose earlier attempt failed and spent the
    // 400k, and the fresh one. Under the ceiling and under the budget, so
    // nothing holds them.
    expect(launched).toHaveLength(2);
  });

  it('holds once the budget is spent, and says so', async () => {
    const { store, mission: m } = mission({ budgetTokens: 500_000 });
    const spent = readyTask(store, m.id);
    const past = pastRun(store, m.id, spent.id, Date.now() - 60_000);
    const recorded = store.runs.recordTokens(past.id, 500_000);
    if (!recorded.ok) throw new Error(recorded.message);
    readyTask(store, m.id);

    const launched: string[] = [];
    const result = await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    expect(launched).toEqual([]);
    expect(result?.launched).toBe(0);
    expect(kinds(store, m.id)).toContain('mission_held');
  });

  it('holds when even one of its runs cannot be measured', async () => {
    // The fleet's standing bias, applied to arithmetic: a mission's budget is
    // spent by every attempt it has made, so skipping the runs nobody could
    // measure would report a spend that is definitely too low and call it a
    // measurement. Rows written before the column existed are exactly this.
    const { store, mission: m } = mission({ budgetTokens: 1_000_000 });
    const spent = readyTask(store, m.id);
    const past = pastRun(store, m.id, spent.id, Date.now() - 60_000);
    store.db.prepare('UPDATE child_runs SET tokens = NULL WHERE id = ?').run(past.id);
    readyTask(store, m.id);

    const launched: string[] = [];
    await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    expect(launched).toEqual([]);
  });

  it('writes down what a live child has spent, so the count outlives its session', async () => {
    // The whole reason for the column. A session that has ended has taken its
    // counts with it, and the budget is spent by the attempt either way.
    const { store, mission: m } = mission({ budgetTokens: 1_000_000 });
    const task = readyTask(store, m.id);
    const run = store.runs.create({ missionId: m.id, taskId: task.id, agent: 'claude', attempt: 1, state: 'dispatched' });
    if (!run.ok) throw new Error(run.message);
    const attached = store.runs.attachSession(run.value.id, 'sess-1');
    if (!attached.ok) throw new Error(attached.message);

    await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: () => new Map([['sess-1', { lastActivityAt: Date.now(), tokens: 12_345 }]]),
      launch: async () => true,
    });

    const after = store.runs.get(run.value.id);
    expect(after.ok && after.value?.tokens).toBe(12_345);
  });
});

describe('a mission with no budget at all', () => {
  it('is unaffected, which is what most missions are', async () => {
    const { store, mission: m } = mission();
    const first = readyTask(store, m.id);
    pastRun(store, m.id, first.id, Date.now() - 604_800_000);
    readyTask(store, m.id);

    const launched: string[] = [];
    await pulseMission(m, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    // Two ready tasks, a ceiling of four, and no budget in the way.
    expect(launched).toHaveLength(2);
  });
});
