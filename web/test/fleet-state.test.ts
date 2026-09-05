import type { FleetEvent, Mission, ServerEvent, Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { foldFleet, NO_FLEET, type FleetState } from '../src/fleet-state';

/**
 * The mission layer as the client sees it.
 *
 * Two sources feed one timeline — a page of history in reply to
 * `get_fleet_events`, and a broadcast per commit — and they overlap and
 * interleave by construction. Most of what is here is about that.
 */

const mission = (id: string, over: Partial<Mission> = {}): Mission =>
  ({ id, name: id, body: '', status: 'active', watch: 'paused', pulseSec: 60, maxChildren: 4, cwd: '/repo', agent: 'claude', createdAt: 1, updatedAt: 1, ...over }) as Mission;

const task = (id: string, missionId: string): Task =>
  ({ id, missionId, title: id, description: '', cwd: '/repo', status: 'proposed', priority: 0, dependsOn: [], acceptance: '', createdAt: 1, updatedAt: 1 }) as Task;

const fleetEvent = (seq: number, missionId = 'm1'): FleetEvent =>
  ({ seq, missionId, actor: 'manager', kind: 'dispatched', payload: null, at: seq }) as FleetEvent;

function fold(state: FleetState, ...events: ServerEvent[]): FleetState {
  let next = state;
  for (const event of events) {
    const folded = foldFleet(next, event);
    expect(folded).toBeDefined();
    next = folded as FleetState;
  }
  return next;
}

describe('what the fold owns', () => {
  it('passes on anything that is not the mission layer', () => {
    expect(foldFleet(NO_FLEET, { type: 'notice', message: 'hi' })).toBeUndefined();
    expect(foldFleet(NO_FLEET, { type: 'session_removed', sessionId: 's1' })).toBeUndefined();
  });

  it('takes a mission list', () => {
    const state = fold(NO_FLEET, { type: 'missions', missions: [mission('m1')] });
    expect(state.missions.map((m) => m.id)).toEqual(['m1']);
  });

  it('keeps each mission’s tasks apart', () => {
    const state = fold(
      NO_FLEET,
      { type: 'tasks', missionId: 'm1', tasks: [task('t1', 'm1')] },
      { type: 'tasks', missionId: 'm2', tasks: [task('t2', 'm2')] },
    );
    expect(state.tasks.get('m1')?.map((t) => t.id)).toEqual(['t1']);
    expect(state.tasks.get('m2')?.map((t) => t.id)).toEqual(['t2']);
  });

  it('replaces a task list rather than merging it, so a cancelled task disappears', () => {
    const state = fold(
      NO_FLEET,
      { type: 'tasks', missionId: 'm1', tasks: [task('t1', 'm1'), task('t2', 'm1')] },
      { type: 'tasks', missionId: 'm1', tasks: [task('t1', 'm1')] },
    );
    expect(state.tasks.get('m1')?.map((t) => t.id)).toEqual(['t1']);
  });
});

describe('one timeline out of two sources', () => {
  it('appends a live event to the page it already has', () => {
    const state = fold(
      NO_FLEET,
      { type: 'fleet_events', missionId: 'm1', events: [fleetEvent(1), fleetEvent(2)] },
      { type: 'fleet_event', event: fleetEvent(3) },
    );
    expect(state.events.get('m1')?.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('does not show an event twice when the page and the broadcast overlap', () => {
    // The request is a round trip and the broadcast is not, so a page asked for
    // at the moment an event lands contains it AND the broadcast arrives.
    const state = fold(
      NO_FLEET,
      { type: 'fleet_event', event: fleetEvent(3) },
      { type: 'fleet_events', missionId: 'm1', events: [fleetEvent(1), fleetEvent(2), fleetEvent(3)] },
    );
    expect(state.events.get('m1')?.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('orders by sequence, not by arrival', () => {
    const state = fold(
      NO_FLEET,
      { type: 'fleet_event', event: fleetEvent(5) },
      { type: 'fleet_event', event: fleetEvent(4) },
    );
    expect(state.events.get('m1')?.map((e) => e.seq)).toEqual([4, 5]);
  });

  it('keeps a live event under its own mission, not the one last asked about', () => {
    const state = fold(
      NO_FLEET,
      { type: 'fleet_events', missionId: 'm1', events: [fleetEvent(1)] },
      { type: 'fleet_event', event: fleetEvent(9, 'm2') },
    );
    expect(state.events.get('m1')?.map((e) => e.seq)).toEqual([1]);
    expect(state.events.get('m2')?.map((e) => e.seq)).toEqual([9]);
  });

  it('keeps the newest history when a log outgrows the cap', () => {
    const many = Array.from({ length: 260 }, (_, i) => fleetEvent(i + 1));
    const state = fold(NO_FLEET, { type: 'fleet_events', missionId: 'm1', events: many });
    const kept = state.events.get('m1') ?? [];
    expect(kept).toHaveLength(200);
    expect(kept[kept.length - 1]?.seq).toBe(260);
  });
});

describe('a mission layer that did not open', () => {
  it('says so once', () => {
    const state = fold(NO_FLEET, { type: 'fleet_unavailable', reason: 'the file is locked' });
    expect(state.unavailable).toBe('the file is locked');
  });

  it('stops saying so the moment the layer answers', () => {
    // Otherwise a mission list renders under a banner claiming the database is
    // closed, which is worse than either message on its own.
    const state = fold(
      NO_FLEET,
      { type: 'fleet_unavailable', reason: 'the file is locked' },
      { type: 'missions', missions: [mission('m1')] },
    );
    expect(state.unavailable).toBeUndefined();
  });
});

describe('the state it hands back', () => {
  it('never mutates the state it was given', () => {
    const before = fold(NO_FLEET, { type: 'missions', missions: [mission('m1')] });
    const after = fold(before, { type: 'missions', missions: [mission('m1'), mission('m2')] });
    expect(before.missions).toHaveLength(1);
    expect(after.missions).toHaveLength(2);
    expect(after).not.toBe(before);
  });

  it('holds mission ids in a Map, which has no prototype to poison', () => {
    // The same finding CodeQL raised five times against the mirror state: a
    // remote string written as a property name is prototype pollution.
    const state = fold(NO_FLEET, { type: 'tasks', missionId: '__proto__', tasks: [task('t1', '__proto__')] });
    expect(state.tasks.get('__proto__')?.map((t) => t.id)).toEqual(['t1']);
    expect(({} as Record<string, unknown>)['t1']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('t1');
  });
});
