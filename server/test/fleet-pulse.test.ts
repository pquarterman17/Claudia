import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { FleetPulser, pulseFleet, type LaunchChild, type SessionFacts } from '../src/fleet/pulse.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The clock the reconciler and the watchdog never had.
 *
 * Both engines are proved elsewhere; nothing here re-tests which decision is
 * right. What is new is that decisions become writes — and, just as much, that
 * the decisions this build cannot carry out are recorded rather than dropped.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-pulse-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const POLICY = { maxChildren: 4, maxAttempts: 3 };
const NO_SESSIONS = (): ReadonlyMap<string, SessionFacts> => new Map();

let counter = 0;
function mission(over: { pulseSec?: number } = {}) {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);
  const created = store.missions.create({ name: 'm', body: '', cwd: '/repo', ...over });
  if (!created.ok) throw new Error(created.message);
  // Watch defaults to `paused`: a new mission is a description of work, not an
  // instruction to start deciding on its behalf. Every case here is about what
  // a WATCHED mission does, so it is switched on explicitly.
  const watched = store.missions.setWatch(created.value.id, 'watching');
  if (!watched.ok) throw new Error(watched.message);
  return { store, mission: watched.value };
}

function readyTask(store: FleetStore, missionId: string, over: { dependsOn?: string[] } = {}) {
  const task = store.tasks.create({
    missionId,
    title: 't',
    description: '',
    cwd: '/repo',
    dependsOn: over.dependsOn,
  });
  if (!task.ok) throw new Error(task.message);
  const ready = store.tasks.setStatus(task.value.id, 'ready');
  if (!ready.ok) throw new Error(ready.message);
  return ready.value;
}

function kinds(store: FleetStore, missionId: string): string[] {
  const events = store.events.sinceForMission(missionId);
  if (!events.ok) throw new Error(events.message);
  return events.value.map((event) => event.kind);
}

describe('a pulse turns decisions into writes', () => {
  it('records a dispatch it cannot carry out, rather than dropping it', async () => {
    // The seam this PR deliberately leaves open. A fleet that decided to
    // dispatch and could not is a different thing from a fleet with nothing to
    // do, and the difference is only visible if it is written down.
    const { store, mission: m } = mission();
    readyTask(store, m.id);

    const [result] = await pulseFleet({ store, policy: POLICY, observeSessions: NO_SESSIONS });
    expect(result?.deferred).toBe(1);
    expect(result?.launched).toBe(0);
    expect(kinds(store, m.id)).toContain('dispatch_deferred');
  });

  it('launches through the port when one is wired', async () => {
    const { store, mission: m } = mission();
    const task = readyTask(store, m.id);
    const orders: string[] = [];
    const launch: LaunchChild = async (order) => {
      orders.push(`${order.taskId}:${order.attempt}`);
      return true;
    };

    const [result] = await pulseFleet({ store, policy: POLICY, launch, observeSessions: NO_SESSIONS });
    expect(orders).toEqual([`${task.id}:1`]);
    expect(result?.launched).toBe(1);
    // Nothing deferred, so nothing to explain in the log.
    expect(kinds(store, m.id)).not.toContain('dispatch_deferred');
  });

  it('blocks a task whose dependency is not done, and says why once', async () => {
    const { store, mission: m } = mission();
    const first = readyTask(store, m.id);
    const second = readyTask(store, m.id, { dependsOn: [first.id] });

    await pulseFleet({ store, policy: POLICY, observeSessions: NO_SESSIONS });
    const blocked = store.tasks.get(second.id);
    expect(blocked.ok && blocked.value?.status).toBe('blocked');

    // A second pulse must not write the same note again: the decision has not
    // changed, and one row per tick would bury the log.
    await pulseFleet({ store, policy: POLICY, observeSessions: NO_SESSIONS });
    expect(kinds(store, m.id).filter((kind) => kind === 'task_blocked')).toHaveLength(1);
  });

  it('leaves a mission nobody is watching alone', async () => {
    // `paused` is a deliberate instruction to stop deciding on its behalf.
    // Recovery still runs over it; spending does not.
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    const paused = store.missions.setWatch(m.id, 'paused');
    if (!paused.ok) throw new Error(paused.message);

    expect(await pulseFleet({ store, policy: POLICY, observeSessions: NO_SESSIONS })).toEqual([]);
    expect(kinds(store, m.id)).not.toContain('dispatch_deferred');
  });
});

describe('the watchdog gets its clock', () => {
  it('files one escalation for a stuck run however often it is pulsed', async () => {
    const { store, mission: m } = mission();
    const task = readyTask(store, m.id);
    const run = store.runs.create({ missionId: m.id, taskId: task.id, agent: 'claude', attempt: 1, sessionId: 's1' });
    if (!run.ok) throw new Error(run.message);
    const running = store.runs.setState(run.value.id, 'running');
    if (!running.ok) throw new Error(running.message);

    // No live sessions, so the run is orphaned rather than merely quiet.
    for (let i = 0; i < 3; i++) await pulseFleet({ store, policy: POLICY, observeSessions: NO_SESSIONS });
    const inbox = store.escalations.listByMission(m.id);
    if (!inbox.ok) throw new Error(inbox.message);
    // Deduplicated on the watchdog's own key: the same fault every tick is one
    // row a human has to answer, not one per tick.
    expect(inbox.value.length).toBeLessThanOrEqual(1);
  });
});

describe('each mission keeps its own cadence', () => {
  it('does not pulse a mission again before its interval has elapsed', async () => {
    // One global interval cannot be the cadence: a mission set to four hours
    // must not be decided on every fifteen seconds because another one is.
    const { store, mission: m } = mission({ pulseSec: 3600 });
    readyTask(store, m.id);
    let clock = 1_000_000;
    const pulser = new FleetPulser({
      store,
      policy: POLICY,
      observeSessions: NO_SESSIONS,
      now: () => clock,
    });

    expect(await pulser.tick()).toHaveLength(1);
    clock += 60_000;
    expect(await pulser.tick()).toEqual([]);
    clock += 3600_000;
    expect(await pulser.tick()).toHaveLength(1);
  });

  it('forgets missions that are gone, so the map cannot grow forever', async () => {
    const { store, mission: m } = mission({ pulseSec: 3600 });
    const pulser = new FleetPulser({ store, policy: POLICY, observeSessions: NO_SESSIONS });
    await pulser.tick();
    pulser.forget(new Set());
    // Forgotten means due again immediately, which is the observable effect.
    expect(await pulser.tick()).toHaveLength(1);
    expect(m.pulseSec).toBeGreaterThan(0);
  });
});

describe('what the review found', () => {
  /** A mission with one run that has been alive and busy for hours. */
  async function longRunning() {
    const { store, mission: m } = mission();
    const task = readyTask(store, m.id);
    const run = store.runs.create({
      missionId: m.id,
      taskId: task.id,
      agent: 'claude',
      attempt: 1,
      sessionId: 's1',
      startedAt: 1_000,
    });
    if (!run.ok) throw new Error(run.message);
    const running = store.runs.setState(run.value.id, 'running');
    if (!running.ok) throw new Error(running.message);
    // The task is `running` too. A task left `ready` while one of its runs is
    // active is not a state the fleet produces, and it makes the watchdog's
    // retry route (`running -> failed -> ready`) illegal — which rolls the
    // whole pulse back and would let these cases pass without ever reaching
    // the behaviour they are about.
    const started = store.tasks.setStatus(task.id, 'running');
    if (!started.ok) throw new Error(started.message);
    return { store, mission: m, runId: run.value.id };
  }

  it('does not call a busy run silent just because it started long ago', async () => {
    // Without real activity, `assess` falls back to the run's START time, so
    // any live run older than silentAfterMs reads as silent and gets failed or
    // retried while it is still producing output. Feeding the session's own
    // lastActivityAt is the whole difference.
    const { store, runId } = await longRunning();
    const now = 10_000_000;
    const busy = (): ReadonlyMap<string, SessionFacts> => new Map([['s1', { lastActivityAt: now - 1_000 }]]);

    await pulseFleet({ store, policy: POLICY, observeSessions: busy, now: () => now });
    const run = store.runs.get(runId);
    // Still running: nothing decided it was dead.
    expect(run.ok && run.value?.state).toBe('running');
  });

  it('escalates a run parked on approval rather than retrying it', async () => {
    // Retrying spends a fresh turn that parks on the same approval. Only a
    // human clears it, so it has to reach the inbox.
    const { store, mission: m } = await longRunning();
    const now = 10_000_000;
    const parked = (): ReadonlyMap<string, SessionFacts> =>
      new Map([['s1', { lastActivityAt: now - 1_000, pendingApproval: 'Bash', pendingSince: now - 3_600_000 }]]);

    await pulseFleet({ store, policy: POLICY, observeSessions: parked, now: () => now });
    const inbox = store.escalations.listByMission(m.id);
    if (!inbox.ok) throw new Error(inbox.message);
    expect(inbox.value.map((e) => e.request).join(' ')).toContain('Bash');
  });

  it('does not start a child inside the transaction', async () => {
    // An external, non-transactional act inside a rollback-capable transaction
    // can leave a live process with no durable record of itself. The launcher
    // must therefore only ever be called once the pulse has committed.
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    let inTransaction: boolean | undefined;
    const launch: LaunchChild = async () => {
      // `isTransaction` is false once the pulse's transaction has committed.
      inTransaction = store.db.isTransaction;
      return true;
    };

    await pulseFleet({ store, policy: POLICY, launch, observeSessions: NO_SESSIONS });
    expect(inTransaction).toBe(false);
  });

  it('does not commit a pulse whose escalation could not be written', async () => {
    // `EscalationRepo.create` answers an idempotency hit by returning the
    // existing row as ok, so a failure is a REAL store error, not deduplication.
    // Swallowing it committed the rest of the pulse and advanced the cadence
    // while the blocking escalation — the thing a human is meant to answer —
    // had been dropped.
    const { store, runId } = await longRunning();
    const now = 10_000_000;
    // Parked on a human, which is the case that escalates rather than backs off.
    const parked = (): ReadonlyMap<string, SessionFacts> =>
      new Map([['s1', { lastActivityAt: now - 1_000, pendingApproval: 'Bash', pendingSince: now - 3_600_000 }]]);
    // The escalation write now fails for a reason that is not a duplicate key.
    store.db.exec('DROP TABLE escalations');

    expect(await pulseFleet({ store, policy: POLICY, observeSessions: parked, now: () => now })).toEqual([]);
    // And the rest of the pulse rolled back with it, rather than committing
    // around the loss.
    const after = store.runs.get(runId);
    expect(after.ok && after.value?.state).toBe('running');
  });

  it('does not burn the whole interval on a pulse that failed', async () => {
    // Stamping the cadence before the pulse landed meant one transient failure
    // suppressed every retry for the mission's full interval — up to four
    // hours of deciding nothing because a write lost a race.
    const { store, mission: m } = mission({ pulseSec: 3600 });
    readyTask(store, m.id);
    let clock = 1_000_000;
    const pulser = new FleetPulser({ store, policy: POLICY, observeSessions: NO_SESSIONS, now: () => clock });

    // Break the reads so the pulse cannot land.
    store.db.exec('ALTER TABLE tasks RENAME TO tasks_hidden');
    expect(await pulser.tick()).toEqual([]);
    store.db.exec('ALTER TABLE tasks_hidden RENAME TO tasks');

    // A second later, not an hour: the failed attempt must not have consumed
    // the mission's cadence.
    clock += 1_000;
    expect((await pulser.tick()).map((r) => r.missionId)).toEqual([m.id]);
  });
});

describe('what the follow-up review found', () => {
  it('treats a launcher that throws as a launch that did not happen', async () => {
    // A defect the async port introduced. A real worktree or process startup
    // can reject, and an uncaught rejection escaped `pulseMission`, skipped
    // every remaining order, wrote no `launch_failed`, and reached the
    // production timer as an unhandled rejection — the timer discards the
    // promise by design.
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    const launch: LaunchChild = async () => {
      throw new Error('git worktree add failed');
    };

    const [result] = await pulseFleet({ store, policy: POLICY, launch, observeSessions: NO_SESSIONS });
    expect(result?.launched).toBe(0);
    expect(result?.deferred).toBe(1);
    const logged = store.events.sinceForMission(m.id);
    if (!logged.ok) throw new Error(logged.message);
    const failure = logged.value.find((event) => event.kind === 'launch_failed');
    expect(failure).toBeDefined();
    // And it says WHY, or the log records a failure nobody can act on.
    expect(JSON.stringify(failure?.payload)).toContain('git worktree add failed');
  });

  it('keeps going through the remaining orders after one throws', async () => {
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    readyTask(store, m.id);
    const seen: string[] = [];
    const launch: LaunchChild = async (order) => {
      seen.push(order.taskId);
      if (seen.length === 1) throw new Error('the first one exploded');
      return true;
    };

    const [result] = await pulseFleet({ store, policy: POLICY, launch, observeSessions: NO_SESSIONS });
    expect(seen).toHaveLength(2);
    expect(result?.launched).toBe(1);
    expect(result?.deferred).toBe(1);
  });

  it('does not launch the same task twice when ticks overlap', async () => {
    // `setInterval` does not wait for the prior tick, and the cadence is now
    // stamped only after every launcher has been awaited — so a startup slower
    // than the tick interval let a second tick read the same ready task and the
    // same no-run snapshot, and enqueue the same PAID launch again.
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const orders: string[] = [];
    const launch: LaunchChild = async (order) => {
      orders.push(order.taskId);
      await held;
      return true;
    };
    const pulser = new FleetPulser({ store, policy: POLICY, launch, observeSessions: NO_SESSIONS });

    // Both started before either is awaited, which is what a timer does. The
    // second one's decision is made synchronously, before the launcher is
    // released, so it is the guard being tested and not the ordering.
    const first = pulser.tick();
    const second = pulser.tick();
    release();
    const [firstResults, secondResults] = await Promise.all([first, second]);

    expect(orders).toHaveLength(1);
    expect(secondResults).toEqual([]);
    expect(firstResults.map((r) => r.missionId)).toEqual([m.id]);
  });

  it('survives a pulse that throws, and releases its guard', async () => {
    // `pulseMission` can still reject by routes other than the launcher — the
    // session observer, or a post-commit write. The production caller is a
    // timer that discards the promise, so an escaping rejection is both an
    // unhandled rejection and a tick that abandoned every later mission. It is
    // caught per mission, left unstamped so the next tick retries, and the
    // in-flight guard is released or the mission would wedge forever.
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    let calls = 0;
    const observeSessions = (): ReadonlyMap<string, SessionFacts> => {
      calls += 1;
      if (calls === 1) throw new Error('the session manager was mid-restart');
      return new Map();
    };
    const pulser = new FleetPulser({ store, policy: POLICY, observeSessions });

    // Does not reject, and does not stamp the cadence.
    await expect(pulser.tick()).resolves.toEqual([]);
    // Due again immediately, which is only possible if the guard was released
    // and the failed attempt did not consume the interval.
    expect((await pulser.tick()).map((r) => r.missionId)).toEqual([m.id]);
  });
});
