import { DEFAULT_FLEET_LIMITS, MAX_ATTEMPTS_CEILING, MAX_CHILDREN_CEILING, usableFleetLimits } from '@claudia/shared';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { FleetPulser, pulseMission, type SessionFacts } from '../src/fleet/pulse.js';
import { handleSettingsCommand, type SettingsCommandCtx } from '../src/settings-commands.js';
import { SettingsStore } from '../src/settings-store.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The fleet's ceilings, from a number a human can change to the pulse that
 * spends against it.
 *
 * The old build pinned `{ maxChildren: 12, maxAttempts: 3 }` in index.ts, so
 * there was nothing to test: the only way to run a smaller fleet was to edit
 * the source. What is new is a value that travels — settings file, wire
 * command, live pulse — and every joint on that path is somewhere it could be
 * dropped or read stale.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-limits-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const NO_SESSIONS = (): ReadonlyMap<string, SessionFacts> => new Map();

let counter = 0;
function watchedMission() {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);
  const created = store.missions.create({ name: 'm', body: '', cwd: '/repo', maxChildren: MAX_CHILDREN_CEILING });
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

describe('reading limits that could be wrong', () => {
  it('answers with the shipped limits for anything that is not a record', () => {
    for (const junk of [undefined, null, 42, 'four', [], true]) {
      expect(usableFleetLimits(junk)).toEqual(DEFAULT_FLEET_LIMITS);
    }
  });

  it('keeps the field that is usable and replaces only the one that is not', () => {
    // The point of clamping rather than refusing: one typo must not discard
    // the neighbouring number the human got right.
    expect(usableFleetLimits({ maxChildren: 2, maxAttempts: 'lots' })).toEqual({
      maxChildren: 2,
      maxAttempts: DEFAULT_FLEET_LIMITS.maxAttempts,
    });
  });

  it('floors at one, because a fleet allowed zero children is a stopped fleet', () => {
    expect(usableFleetLimits({ maxChildren: 0, maxAttempts: -3 })).toEqual({ maxChildren: 1, maxAttempts: 1 });
  });

  it('caps at the ceilings rather than trusting the caller', () => {
    expect(usableFleetLimits({ maxChildren: 9999, maxAttempts: 9999 })).toEqual({
      maxChildren: MAX_CHILDREN_CEILING,
      maxAttempts: MAX_ATTEMPTS_CEILING,
    });
  });

  it('rounds, because half a child is not a number anything is compared against', () => {
    expect(usableFleetLimits({ maxChildren: 2.5, maxAttempts: 1.4 })).toEqual({ maxChildren: 3, maxAttempts: 1 });
  });

  it('refuses NaN and Infinity, which are numbers and are not limits', () => {
    // `Math.min(12, Math.max(1, NaN))` is NaN, and every comparison against it
    // is false — a ceiling that admits everything. It has to be caught before
    // the clamp, not by it.
    expect(usableFleetLimits({ maxChildren: Number.NaN, maxAttempts: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_FLEET_LIMITS,
    );
  });
});

describe('limits on disk', () => {
  it('starts a fresh machine on the shipped limits', () => {
    const store = new SettingsStore(join(dir, 'fresh', 'settings.json'));
    expect(store.get().fleetLimits).toEqual(DEFAULT_FLEET_LIMITS);
  });

  it('survives a settings file written before this field existed', () => {
    const path = join(dir, 'older', 'settings.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ countdownSec: 90 }), 'utf8');
    const store = new SettingsStore(path);
    expect(store.get().countdownSec).toBe(90);
    expect(store.get().fleetLimits).toEqual(DEFAULT_FLEET_LIMITS);
  });

  it('does not let a hand-edited file take the fleet down', () => {
    // The file is documented as hand-editable and the reconciler escalates
    // every task under a policy it cannot read, so this is the difference
    // between a typo and an outage.
    const path = join(dir, 'typo', 'settings.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ fleetLimits: { maxChildren: 'two', maxAttempts: 0 } }), 'utf8');
    expect(new SettingsStore(path).get().fleetLimits).toEqual({
      maxChildren: DEFAULT_FLEET_LIMITS.maxChildren,
      maxAttempts: 1,
    });
  });

  it('persists a change across a restart', () => {
    const path = join(dir, 'persist', 'settings.json');
    new SettingsStore(path).update({ fleetLimits: { maxChildren: 2, maxAttempts: 5 } });
    expect(new SettingsStore(path).get().fleetLimits).toEqual({ maxChildren: 2, maxAttempts: 5 });
  });
});

describe('limits over the wire', () => {
  function ctx(path: string): SettingsCommandCtx & { settings: SettingsStore } {
    const settings = new SettingsStore(path);
    return {
      settings,
      trigger: { setCountdown: () => {}, countdownLength: 30 } as unknown as SettingsCommandCtx['trigger'],
      usage: {} as SettingsCommandCtx['usage'],
      broadcast: () => {},
    };
  }

  it('stores what a client asked for', () => {
    const c = ctx(join(dir, 'wire-ok', 'settings.json'));
    expect(handleSettingsCommand({ type: 'set_fleet_limits', maxChildren: 2, maxAttempts: 5 }, c)).toBe(true);
    expect(c.settings.get().fleetLimits).toEqual({ maxChildren: 2, maxAttempts: 5 });
  });

  it('corrects a value out of range instead of refusing it', () => {
    const c = ctx(join(dir, 'wire-clamp', 'settings.json'));
    handleSettingsCommand({ type: 'set_fleet_limits', maxChildren: 0, maxAttempts: 400 }, c);
    expect(c.settings.get().fleetLimits).toEqual({ maxChildren: 1, maxAttempts: MAX_ATTEMPTS_CEILING });
  });
});

describe('a pulse spends against the limit in force now', () => {
  it('reads the policy at every pulse rather than the one it was built with', async () => {
    // The whole reason the policy is a supplier. The pulser outlives any
    // number it was constructed with, so a limit lowered while it is running
    // has to bind the next pulse — not the next restart.
    const { store, mission: m } = watchedMission();
    readyTask(store, m.id);
    readyTask(store, m.id);
    readyTask(store, m.id);

    let maxChildren = 1;
    let clock = 0;
    const launched: string[] = [];
    const pulser = new FleetPulser({
      store,
      policy: () => ({ maxChildren, maxAttempts: 3 }),
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        launched.push(order.taskId);
        return true;
      },
      // Advanced between ticks, not frozen: the pulser stamps each mission's
      // last pulse and skips it until its own `pulseSec` has elapsed, so a
      // stopped clock would suppress the second tick rather than test it.
      now: () => clock,
    });

    await pulser.tick();
    expect(launched).toHaveLength(1);

    // Raised, and the very next pulse spends it. Nothing was rebuilt.
    maxChildren = 3;
    clock += 61_000;
    // The first child is still running and holds its slot, so a ceiling of
    // three admits exactly two more.
    await pulser.tick();
    expect(launched).toHaveLength(3);
  });

  it('reads the policy once per mission, so one pulse cannot straddle a change', async () => {
    // A pulse decides with the policy and then spends with it. If those were
    // two reads, a settings write landing between them would let a mission
    // dispatch under a ceiling that was already gone.
    const { store, mission: m } = watchedMission();
    readyTask(store, m.id);
    const reads: number[] = [];
    const pulser = new FleetPulser({
      store,
      policy: () => {
        reads.push(Date.now());
        return { maxChildren: 4, maxAttempts: 3 };
      },
      observeSessions: NO_SESSIONS,
      launch: async () => true,
      now: () => 0,
    });
    await pulser.tick();
    expect(reads).toHaveLength(1);
  });
});

describe('a pulse that decides nothing says why', () => {
  async function captureErrors(run: () => Promise<unknown>): Promise<string> {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return lines.join('\n');
  }

  it('names the mission and the reason when its own rows cannot be read', async () => {
    // A store that answers for missions and refuses for tasks — the shape a
    // partly-locked database takes, and the one case where the fleet keeps
    // ticking while a single mission has silently stopped moving.
    const store = {
      tasks: { listByMission: () => ({ ok: false, message: 'database is locked' }) },
      runs: { listByMission: () => ({ ok: true, value: [] }) },
    } as unknown as FleetStore;
    const m = { id: 'm-7', name: 'ship it' } as Parameters<typeof pulseMission>[0];

    let result: unknown = 'unset';
    const logged = await captureErrors(async () => {
      result = await pulseMission(m, { store, policy: DEFAULT_FLEET_LIMITS, observeSessions: NO_SESSIONS });
    });

    expect(result).toBeUndefined();
    expect(logged).toContain('m-7');
    expect(logged).toContain('ship it');
    expect(logged).toContain('database is locked');
  });

  it('says a lasting fault once, not every fifteen seconds until somebody notices', async () => {
    // A failed pulse is not stamped, so it is retried on the next tick and the
    // one after. Reporting each would bury the first line — the only one that
    // says when the fault began — under hundreds of copies of itself.
    const store = {
      tasks: { listByMission: () => ({ ok: false, message: 'database is locked' }) },
      runs: { listByMission: () => ({ ok: true, value: [] }) },
    } as unknown as FleetStore;
    const m = { id: 'm-stuck', name: 'still stuck' } as Parameters<typeof pulseMission>[0];
    const deps = { store, policy: DEFAULT_FLEET_LIMITS, observeSessions: NO_SESSIONS };

    const first = await captureErrors(() => pulseMission(m, deps));
    const second = await captureErrors(() => pulseMission(m, deps));
    expect(first).toContain('database is locked');
    expect(second).toBe('');
  });

  it('says a fault again once its shape changes', async () => {
    // Keyed by mission rather than by message: a second, different failure is
    // new information even while the first one is still being suppressed.
    let message = 'database is locked';
    const store = {
      tasks: { listByMission: () => ({ ok: false, message }) },
      runs: { listByMission: () => ({ ok: true, value: [] }) },
    } as unknown as FleetStore;
    const m = { id: 'm-changing', name: 'shape shifter' } as Parameters<typeof pulseMission>[0];
    const deps = { store, policy: DEFAULT_FLEET_LIMITS, observeSessions: NO_SESSIONS };

    await captureErrors(() => pulseMission(m, deps));
    message = 'no such table: tasks';
    expect(await captureErrors(() => pulseMission(m, deps))).toContain('no such table');
  });

  it('says so when it cannot even find out which missions to pulse', async () => {
    // The widest failure and, before this, the quietest: every mission stops
    // being decided and the tick looks exactly like one with nothing due.
    const { store, mission: m } = watchedMission();
    readyTask(store, m.id);
    store.close();
    const pulser = new FleetPulser({
      store,
      policy: () => DEFAULT_FLEET_LIMITS,
      observeSessions: NO_SESSIONS,
      launch: async () => true,
      now: () => 0,
    });

    const logged = await captureErrors(() => pulser.tick());
    expect(logged).toContain('could not read missions');
  });
});
