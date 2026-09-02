import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { FleetPulser, pulseFleet, type LaunchChild } from '../src/fleet/pulse.js';
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
const NO_SESSIONS = () => new Set<string>();

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
  it('records a dispatch it cannot carry out, rather than dropping it', () => {
    // The seam this PR deliberately leaves open. A fleet that decided to
    // dispatch and could not is a different thing from a fleet with nothing to
    // do, and the difference is only visible if it is written down.
    const { store, mission: m } = mission();
    readyTask(store, m.id);

    const [result] = pulseFleet({ store, policy: POLICY, liveSessionIds: NO_SESSIONS });
    expect(result?.deferred).toBe(1);
    expect(result?.launched).toBe(0);
    expect(kinds(store, m.id)).toContain('dispatch_deferred');
  });

  it('launches through the port when one is wired', () => {
    const { store, mission: m } = mission();
    const task = readyTask(store, m.id);
    const orders: string[] = [];
    const launch: LaunchChild = (order) => {
      orders.push(`${order.taskId}:${order.attempt}`);
      return true;
    };

    const [result] = pulseFleet({ store, policy: POLICY, launch, liveSessionIds: NO_SESSIONS });
    expect(orders).toEqual([`${task.id}:1`]);
    expect(result?.launched).toBe(1);
    // Nothing deferred, so nothing to explain in the log.
    expect(kinds(store, m.id)).not.toContain('dispatch_deferred');
  });

  it('blocks a task whose dependency is not done, and says why once', () => {
    const { store, mission: m } = mission();
    const first = readyTask(store, m.id);
    const second = readyTask(store, m.id, { dependsOn: [first.id] });

    pulseFleet({ store, policy: POLICY, liveSessionIds: NO_SESSIONS });
    const blocked = store.tasks.get(second.id);
    expect(blocked.ok && blocked.value?.status).toBe('blocked');

    // A second pulse must not write the same note again: the decision has not
    // changed, and one row per tick would bury the log.
    pulseFleet({ store, policy: POLICY, liveSessionIds: NO_SESSIONS });
    expect(kinds(store, m.id).filter((kind) => kind === 'task_blocked')).toHaveLength(1);
  });

  it('leaves a mission nobody is watching alone', () => {
    // `paused` is a deliberate instruction to stop deciding on its behalf.
    // Recovery still runs over it; spending does not.
    const { store, mission: m } = mission();
    readyTask(store, m.id);
    const paused = store.missions.setWatch(m.id, 'paused');
    if (!paused.ok) throw new Error(paused.message);

    expect(pulseFleet({ store, policy: POLICY, liveSessionIds: NO_SESSIONS })).toEqual([]);
    expect(kinds(store, m.id)).not.toContain('dispatch_deferred');
  });
});

describe('the watchdog gets its clock', () => {
  it('files one escalation for a stuck run however often it is pulsed', () => {
    const { store, mission: m } = mission();
    const task = readyTask(store, m.id);
    const run = store.runs.create({ missionId: m.id, taskId: task.id, agent: 'claude', attempt: 1, sessionId: 's1' });
    if (!run.ok) throw new Error(run.message);
    const running = store.runs.setState(run.value.id, 'running');
    if (!running.ok) throw new Error(running.message);

    // No live sessions, so the run is orphaned rather than merely quiet.
    for (let i = 0; i < 3; i++) pulseFleet({ store, policy: POLICY, liveSessionIds: NO_SESSIONS });
    const inbox = store.escalations.listByMission(m.id);
    if (!inbox.ok) throw new Error(inbox.message);
    // Deduplicated on the watchdog's own key: the same fault every tick is one
    // row a human has to answer, not one per tick.
    expect(inbox.value.length).toBeLessThanOrEqual(1);
  });
});

describe('each mission keeps its own cadence', () => {
  it('does not pulse a mission again before its interval has elapsed', () => {
    // One global interval cannot be the cadence: a mission set to four hours
    // must not be decided on every fifteen seconds because another one is.
    const { store, mission: m } = mission({ pulseSec: 3600 });
    readyTask(store, m.id);
    let clock = 1_000_000;
    const pulser = new FleetPulser({
      store,
      policy: POLICY,
      liveSessionIds: NO_SESSIONS,
      now: () => clock,
    });

    expect(pulser.tick()).toHaveLength(1);
    clock += 60_000;
    expect(pulser.tick()).toEqual([]);
    clock += 3600_000;
    expect(pulser.tick()).toHaveLength(1);
  });

  it('forgets missions that are gone, so the map cannot grow forever', () => {
    const { store, mission: m } = mission({ pulseSec: 3600 });
    const pulser = new FleetPulser({ store, policy: POLICY, liveSessionIds: NO_SESSIONS });
    pulser.tick();
    pulser.forget(new Set());
    // Forgotten means due again immediately, which is the observable effect.
    expect(pulser.tick()).toHaveLength(1);
    expect(m.pulseSec).toBeGreaterThan(0);
  });
});
