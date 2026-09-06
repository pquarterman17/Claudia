import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { handleFleetCommand, isFleetCommand } from '../src/fleet/commands.js';
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

describe('setting one, which nothing could do', () => {
  /**
   * The other half of a limit that enforces nothing: a limit nobody can set.
   * `budgetSec` and `budgetTokens` were persisted from the first fleet PR and
   * appeared nowhere in the app, so the only way to give a mission a budget
   * was to edit the database by hand — which meant the enforcement fixed one
   * PR earlier could not be reached either.
   */
  it('sets both ceilings, and answers with the missions', () => {
    const { store, mission: m } = mission();
    expect(isFleetCommand({ type: 'set_mission_budget', missionId: m.id, budgetSec: 1, budgetTokens: 1 })).toBe(true);

    const events = handleFleetCommand(
      { type: 'set_mission_budget', missionId: m.id, budgetSec: 7_200, budgetTokens: 500_000 },
      store,
    );
    expect(events.some((e) => e.type === 'missions')).toBe(true);
    const read = store.missions.get(m.id);
    expect(read.ok && read.value?.budgetSec).toBe(7_200);
    expect(read.ok && read.value?.budgetTokens).toBe(500_000);
  });

  it('clears one with null, which is the only way back to unlimited', () => {
    // A mission that has hit a ceiling stops dispatching, so the person who
    // decides to let it carry on needs a way to say so. `null` is a value the
    // caller means, which is why both fields are required on the wire.
    const { store, mission: m } = mission({ budgetSec: 60, budgetTokens: 1_000 });
    handleFleetCommand({ type: 'set_mission_budget', missionId: m.id, budgetSec: null, budgetTokens: 2_000 }, store);
    const read = store.missions.get(m.id);
    expect(read.ok && read.value?.budgetSec).toBeUndefined();
    expect(read.ok && read.value?.budgetTokens).toBe(2_000);
  });

  it('refuses a budget that is not one, in the store rather than only in the form', () => {
    // The same `ceiling` check `create` uses. Two paths were reaching this
    // column and only one of them was checking.
    const { store, mission: m } = mission();
    for (const bad of [0, -1, 1.5]) {
      expect(store.missions.setBudget(m.id, { budgetSec: bad }).ok, `${bad}`).toBe(false);
    }
    const events = handleFleetCommand(
      { type: 'set_mission_budget', missionId: m.id, budgetSec: 0, budgetTokens: null },
      store,
    );
    const notice = events.find((e) => e.type === 'notice');
    expect(notice && 'message' in notice ? notice.message : '').toMatch(/whole number above zero/);
  });

  it('is a budget the pulse then enforces, end to end', async () => {
    // The loop closed: set from the wire, spent by a run, held by the pulse.
    const { store, mission: m } = mission();
    handleFleetCommand({ type: 'set_mission_budget', missionId: m.id, budgetSec: null, budgetTokens: 1_000 }, store);
    const read = store.missions.get(m.id);
    if (!read.ok || !read.value) throw new Error('the mission vanished');

    const task = readyTask(store, m.id);
    const past = pastRun(store, m.id, task.id, Date.now() - 60_000);
    const recorded = store.runs.recordTokens(past.id, 1_000);
    if (!recorded.ok) throw new Error(recorded.message);
    readyTask(store, m.id);

    const launched: string[] = [];
    await pulseMission(read.value, {
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
    });
    expect(launched).toEqual([]);
    expect(kinds(store, m.id)).toContain('mission_held');
  });
});

describe('showing what it has spent', () => {
  it('reports each mission\'s spend beside its budget', () => {
    // A budget with no spend beside it is a number nobody can act on: the
    // question anyone has is not "what is the limit" but "how close is it".
    const { store, mission: m } = mission({ budgetTokens: 1_000_000 });
    const task = readyTask(store, m.id);
    const past = pastRun(store, m.id, task.id, Date.now() - 60_000);
    const recorded = store.runs.recordTokens(past.id, 250_000);
    if (!recorded.ok) throw new Error(recorded.message);

    const events = handleFleetCommand({ type: 'list_missions' }, store);
    const listed = events.find((e) => e.type === 'missions');
    if (!listed || listed.type !== 'missions') throw new Error('no mission list');
    const spend = listed.spend.find((s) => s.missionId === m.id);
    expect(spend?.tokens).toBe(250_000);
    expect(spend?.elapsedSec).toBeGreaterThan(50);
  });

  it('sends null, not zero, for a spend nobody could measure', () => {
    // The state in which the fleet refuses to dispatch. Drawn as 0 it would
    // show headroom the mission does not have, on the one screen where
    // somebody decides whether to raise the limit — and JSON has no NaN.
    const { store, mission: m } = mission({ budgetTokens: 1_000_000 });
    const task = readyTask(store, m.id);
    const past = pastRun(store, m.id, task.id, Date.now() - 60_000);
    store.db.prepare('UPDATE child_runs SET tokens = NULL WHERE id = ?').run(past.id);

    const events = handleFleetCommand({ type: 'list_missions' }, store);
    const listed = events.find((e) => e.type === 'missions');
    if (!listed || listed.type !== 'missions') throw new Error('no mission list');
    expect(listed.spend.find((s) => s.missionId === m.id)?.tokens).toBeNull();
  });

  it('measures it the way the pulse does, rather than a second opinion', () => {
    // Two counts of what a mission has spent would disagree on exactly the
    // cases that matter, and the board would then contradict the hold.
    const { store, mission: m } = mission({ budgetTokens: 500 });
    const task = readyTask(store, m.id);
    const past = pastRun(store, m.id, task.id, Date.now() - 60_000);
    const recorded = store.runs.recordTokens(past.id, 500);
    if (!recorded.ok) throw new Error(recorded.message);

    const events = handleFleetCommand({ type: 'list_missions' }, store);
    const listed = events.find((e) => e.type === 'missions');
    if (!listed || listed.type !== 'missions') throw new Error('no mission list');
    const spend = listed.spend.find((s) => s.missionId === m.id);
    // The same number `overBudget` is about to hold this mission on.
    expect(spend?.tokens).toBe(500);
    expect(spend?.tokens).toBeGreaterThanOrEqual(m.budgetTokens ?? 0);
  });
});
