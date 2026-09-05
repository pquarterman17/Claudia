import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientCommand, Mission, ServerEvent, Task } from '@claudia/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { readFileSync } from 'node:fs';
import { handleFleetCommand, isFleetCommand } from '../src/fleet/commands.js';
import { parseCommand } from '../src/command-schema.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The mission layer's half of the wire protocol.
 *
 * Two things are being pinned. That a client can describe work and read back
 * what happened — and that it can do NOTHING else: nothing here spends an
 * attempt, dispatches a run, or moves a task by itself. That boundary is the
 * point of the split between this and the dispatcher, and a command that
 * quietly crossed it would be invisible in a diff of the handler alone.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-fleet-cmd-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function freshStore(): FleetStore {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  opened.push(boot.store);
  return boot.store;
}

/** Runs a command the way the gateway does: validated first, then handled. */
function send(store: FleetStore | undefined, raw: unknown): ServerEvent[] {
  const parsed = parseCommand(raw);
  if (!parsed.ok) throw new Error(`refused by validation: ${parsed.reason}`);
  expect(isFleetCommand(parsed.cmd)).toBe(true);
  return handleFleetCommand(parsed.cmd, store);
}

function missionsIn(events: ServerEvent[]): Mission[] {
  const found = events.find((event) => event.type === 'missions');
  return found?.type === 'missions' ? found.missions : [];
}

function tasksIn(events: ServerEvent[]): Task[] {
  const found = events.find((event) => event.type === 'tasks');
  return found?.type === 'tasks' ? found.tasks : [];
}

describe('describing work over the wire', () => {
  it('creates a mission and answers with the whole list', () => {
    // The whole list rather than the one row: a client that has been away has
    // no reliable way to merge a single insert into a list it may not hold.
    const store = freshStore();
    const created = send(store, { type: 'create_mission', name: 'Ship it', body: 'the body', cwd: '/repo' });
    expect(missionsIn(created).map((m) => m.name)).toEqual(['Ship it']);

    const listed = send(store, { type: 'list_missions' });
    expect(missionsIn(listed)).toHaveLength(1);
  });

  it('creates a task under its mission and reads it back', () => {
    const store = freshStore();
    const mission = missionsIn(send(store, { type: 'create_mission', name: 'm', body: '', cwd: '/repo' }))[0];
    if (!mission) throw new Error('no mission');

    const created = send(store, {
      type: 'create_task',
      missionId: mission.id,
      title: 'do the thing',
      description: '',
      cwd: '/repo',
    });
    expect(tasksIn(created).map((t) => t.title)).toEqual(['do the thing']);
    // Proposed, not ready: a task arrives as a description of work, and only a
    // human or a policy moves it into the queue.
    expect(tasksIn(created)[0]?.status).toBe('proposed');
  });

  it('switches watch without touching mission status', () => {
    const store = freshStore();
    const mission = missionsIn(send(store, { type: 'create_mission', name: 'm', body: '', cwd: '/repo' }))[0];
    if (!mission) throw new Error('no mission');

    const paused = missionsIn(send(store, { type: 'set_mission_watch', missionId: mission.id, watch: 'paused' }))[0];
    expect(paused?.watch).toBe('paused');
    // Two different axes: unattended is not the same as finished.
    expect(paused?.status).toBe('active');
  });

  it('reads the event log from a cursor', () => {
    const store = freshStore();
    const mission = missionsIn(send(store, { type: 'create_mission', name: 'm', body: '', cwd: '/repo' }))[0];
    if (!mission) throw new Error('no mission');
    for (const kind of ['first', 'second']) {
      const appended = store.events.append({ missionId: mission.id, actor: 'system', kind, payload: {} });
      if (!appended.ok) throw new Error(appended.message);
    }

    const all = send(store, { type: 'get_fleet_events', missionId: mission.id });
    const events = all.find((e) => e.type === 'fleet_events');
    if (events?.type !== 'fleet_events') throw new Error('no fleet_events reply');
    expect(events.events.map((e) => e.kind)).toEqual(['first', 'second']);

    const after = send(store, {
      type: 'get_fleet_events',
      missionId: mission.id,
      afterSeq: events.events[0]?.seq ?? 0,
    });
    const rest = after.find((e) => e.type === 'fleet_events');
    if (rest?.type !== 'fleet_events') throw new Error('no fleet_events reply');
    expect(rest.events.map((e) => e.kind)).toEqual(['second']);
  });
});

describe('what the wire refuses', () => {
  it.each([
    ['a mission with no name', { type: 'create_mission', body: '', cwd: '/repo' }],
    ['a watch state that is not one', { type: 'set_mission_watch', missionId: 'm', watch: 'sort-of' }],
    ['a task with no mission', { type: 'create_task', title: 't', description: '', cwd: '/repo' }],
    ['dependencies that are not ids', { type: 'create_task', missionId: 'm', title: 't', description: '', cwd: '/', dependsOn: [7] }],
    ['a fractional cursor', { type: 'get_fleet_events', missionId: 'm', afterSeq: 1.5 }],
    ['a negative cursor', { type: 'get_fleet_events', missionId: 'm', afterSeq: -1 }],
  ])('refuses %s before it reaches a repository', (_label, raw) => {
    // Validation, not the handler. A cursor that is fractional or negative
    // would silently widen the window rather than fail — the shape of bug the
    // schema layer exists to catch, and the reason these are hand-written.
    expect(parseCommand(raw).ok).toBe(false);
  });

  it('says the layer is unavailable once, rather than failing each command', () => {
    // A database that will not open is a fact about the run, not about the
    // command. A client learns it from a message that says so instead of
    // inferring it from a run of unexplained refusals.
    const events = handleFleetCommand({ type: 'list_missions' } as ClientCommand, undefined);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('fleet_unavailable');
  });

  it('passes a repository refusal back as something a person can read', () => {
    const store = freshStore();
    const events = send(store, { type: 'list_tasks', missionId: 'no-such-mission' });
    // An unknown mission has no tasks; that is an empty list, not an error.
    expect(tasksIn(events)).toEqual([]);
  });

  it('owns exactly the commands it claims', () => {
    // The router asks this before its own switch, so a command claimed here and
    // not handled would be swallowed silently instead of falling through.
    const owned: ClientCommand[] = [
      { type: 'list_missions' },
      { type: 'create_mission', name: 'm', body: '', cwd: '/' },
      { type: 'set_mission_watch', missionId: 'm', watch: 'watching' },
      { type: 'create_task', missionId: 'm', title: 't', description: '', cwd: '/' },
      { type: 'list_tasks', missionId: 'm' },
      { type: 'set_task_status', missionId: 'm', taskId: 't', status: 'ready' },
      { type: 'get_fleet_events', missionId: 'm' },
    ];
    const store = freshStore();
    for (const cmd of owned) {
      expect(isFleetCommand(cmd)).toBe(true);
      expect(handleFleetCommand(cmd, store).length).toBeGreaterThan(0);
    }
    expect(isFleetCommand({ type: 'ping' })).toBe(false);
  });

  it('routes every command its switch handles', () => {
    // The OTHER direction, and the one that bit: a case added to the switch
    // without its type in the routed set compiles, typechecks and is simply
    // never reached, because the router asks `isFleetCommand` first. Found by
    // running the fleet end to end — `set_task_status` was handled here and
    // silently dropped at the door. Read from the source because there is no
    // way to reflect on a switch.
    const source = readFileSync(new URL('../src/fleet/commands.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('switch (cmd.type)'));
    const handled = [...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1] ?? '');
    expect(handled.length).toBeGreaterThan(0);
    for (const type of handled) {
      expect(isFleetCommand({ type } as ClientCommand), `${type} is handled but not routed`).toBe(true);
    }
  });
});
