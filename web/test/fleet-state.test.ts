import type { Escalation, FleetEvent, Mission, ServerEvent, Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { foldFleet, nextPageFrom, NO_FLEET, type FleetState } from '../src/fleet-state';

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

describe('the inbox', () => {
  const escalation = (id: string, missionId = 'm1', resolution: Escalation['resolution'] = 'pending'): Escalation =>
    ({ id, missionId, source: 'system', request: 'git push', reason: 'parked', severity: 'blocking', resolution, createdAt: 1 }) as Escalation;

  it('keeps each mission’s escalations apart', () => {
    const state = fold(
      NO_FLEET,
      { type: 'escalations', missionId: 'm1', escalations: [escalation('e1')] },
      { type: 'escalations', missionId: 'm2', escalations: [escalation('e2', 'm2')] },
    );
    expect(state.escalations.get('m1')?.map((e) => e.id)).toEqual(['e1']);
    expect(state.escalations.get('m2')?.map((e) => e.id)).toEqual(['e2']);
  });

  it('replaces rather than merges, so an answered one disappears', () => {
    // The server answers a resolve with what is STILL pending. Merging would
    // leave the thing just decided sitting in the inbox.
    const state = fold(
      NO_FLEET,
      { type: 'escalations', missionId: 'm1', escalations: [escalation('e1'), escalation('e2')] },
      { type: 'escalations', missionId: 'm1', escalations: [escalation('e2')] },
    );
    expect(state.escalations.get('m1')?.map((e) => e.id)).toEqual(['e2']);
  });

  it('starts empty rather than undefined, so a mission never renders a stale inbox', () => {
    expect(NO_FLEET.escalations.size).toBe(0);
    expect(NO_FLEET.escalations.get('m1')).toBeUndefined();
  });
});

describe('one timeline out of two sources', () => {
  it('appends a live event to the page it already has', () => {
    const state = fold(
      NO_FLEET,
      { type: 'fleet_events', missionId: 'm1', events: [fleetEvent(1), fleetEvent(2)], elided: 0, more: false, throughSeq: 0 },
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
      { type: 'fleet_events', missionId: 'm1', events: [fleetEvent(1), fleetEvent(2), fleetEvent(3)], elided: 0, more: false, throughSeq: 0 },
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
      { type: 'fleet_events', missionId: 'm1', events: [fleetEvent(1)], elided: 0, more: false, throughSeq: 0 },
      { type: 'fleet_event', event: fleetEvent(9, 'm2') },
    );
    expect(state.events.get('m1')?.map((e) => e.seq)).toEqual([1]);
    expect(state.events.get('m2')?.map((e) => e.seq)).toEqual([9]);
  });

  it('keeps the newest history when a log outgrows the cap', () => {
    const many = Array.from({ length: 260 }, (_, i) => fleetEvent(i + 1));
    const state = fold(NO_FLEET, { type: 'fleet_events', missionId: 'm1', events: many, elided: 0, more: false, throughSeq: 0 });
    const kept = state.events.get('m1') ?? [];
    expect(kept).toHaveLength(200);
    expect(kept[kept.length - 1]?.seq).toBe(260);
  });
});

describe('a page that admits to being one', () => {
  const page = (over: Partial<{ events: FleetEvent[]; elided: number; more: boolean; throughSeq: number; reset: string }> = {}) =>
    ({
      type: 'fleet_events' as const,
      missionId: 'm1',
      events: [fleetEvent(1)],
      elided: 0,
      more: false,
      throughSeq: 1,
      ...over,
    });

  it('remembers how many it was not sent', () => {
    const state = fold(NO_FLEET, page({ elided: 700 }));
    expect(state.pages.get('m1')?.elided).toBe(700);
  });

  it('remembers where to ask from next, which is the window and not the last event', () => {
    // The two differ whenever the window was sparse. Continuing from the last
    // event would re-walk a gap the server already said was empty, one
    // sequence per round trip.
    const state = fold(NO_FLEET, page({ events: [fleetEvent(2)], more: true, throughSeq: 501 }));
    expect(state.pages.get('m1')?.through).toBe(501);
    expect(state.pages.get('m1')?.more).toBe(true);
  });

  it('adds what its own cap dropped to what the server skipped', () => {
    // A viewer told "12 earlier events" when 212 are missing has been given a
    // number worse than none.
    const many = Array.from({ length: 260 }, (_, i) => fleetEvent(i + 1));
    const state = fold(NO_FLEET, page({ events: many, elided: 700, throughSeq: 260 }));
    expect(state.events.get('m1')).toHaveLength(200);
    expect(state.pages.get('m1')?.elided).toBe(760);
  });

  it('discards what it holds when told its cursor could not be replayed', () => {
    // Merging would splice a fresh page onto a history that never led to it,
    // producing a timeline that looks continuous and is not.
    const before = fold(NO_FLEET, page({ events: [fleetEvent(1), fleetEvent(2)], throughSeq: 2 }));
    const after = fold(before, page({ events: [fleetEvent(90)], throughSeq: 90, reset: 'the client is ahead of the log' }));
    expect(after.events.get('m1')?.map((e) => e.seq)).toEqual([90]);
  });

  it('merges when there is no reset, which is the ordinary case', () => {
    const before = fold(NO_FLEET, page({ events: [fleetEvent(1)], throughSeq: 1 }));
    const after = fold(before, page({ events: [fleetEvent(2)], throughSeq: 2 }));
    expect(after.events.get('m1')?.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('how many earlier events are missing', () => {
  const page = (over: Partial<{ events: FleetEvent[]; elided: number; more: boolean; throughSeq: number; reset: string }> = {}) =>
    ({ type: 'fleet_events' as const, missionId: 'm1', events: [], elided: 0, more: false, throughSeq: 0, ...over });
  const run = (from: number, count: number) => Array.from({ length: count }, (_, i) => fleetEvent(from + i));

  it('counts the whole prefix after a capped tail is followed by a catch-up', () => {
    // The count must never move BACKWARD. A tail of a 1,200-event log keeps
    // 200 and 1,000 precede them; 500 more arrive and 1,500 precede the
    // rendered tail. Counting only what this one merge evicted reports 500 and
    // tells the viewer the history got shorter.
    const tail = fold(NO_FLEET, page({ events: run(701, 500), elided: 700, throughSeq: 1200 }));
    expect(tail.pages.get('m1')?.elided).toBe(1000);

    const caught = fold(tail, page({ events: run(1201, 500), elided: 0, throughSeq: 1700 }));
    expect(caught.events.get('m1')?.[0]?.seq).toBe(1501);
    expect(caught.pages.get('m1')?.elided).toBe(1500);
  });

  it('does not count an event it already had as one it lost', () => {
    // A live broadcast and the page that also contains it. The union
    // deduplicates, so nothing was evicted — but subtracting lengths reads the
    // collapse as an omission and inflates the count.
    const seen = fold(NO_FLEET, page({ events: run(1, 3), throughSeq: 3 }));
    const withBroadcast = fold(seen, { type: 'fleet_event', event: fleetEvent(4) });
    const overlapping = fold(withBroadcast, page({ events: run(4, 2), throughSeq: 5 }));
    expect(overlapping.events.get('m1')?.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(overlapping.pages.get('m1')?.elided).toBe(0);
  });

  it('starts the count again when it is told to discard what it holds', () => {
    // A reset means the prior history never led here, so the number that
    // described it cannot be carried forward either.
    const before = fold(NO_FLEET, page({ events: run(701, 500), elided: 700, throughSeq: 1200 }));
    expect(before.pages.get('m1')?.elided).toBe(1000);
    const after = fold(before, page({ events: run(1, 5), elided: 0, throughSeq: 5, reset: 'the client is ahead of the log' }));
    expect(after.pages.get('m1')?.elided).toBe(0);
  });

  it('holds steady when a page adds nothing new', () => {
    const first = fold(NO_FLEET, page({ events: run(701, 500), elided: 700, throughSeq: 1200 }));
    const again = fold(first, page({ events: run(1101, 100), elided: 0, throughSeq: 1200 }));
    expect(again.pages.get('m1')?.elided).toBe(1000);
  });
});

describe('deciding whether to ask for another page', () => {
  const page = (over: { more: boolean; throughSeq: number }) =>
    ({ type: 'fleet_events' as const, missionId: 'm1', events: [], elided: 0, ...over });

  it('asks again from the window the server named', () => {
    const state = fold(NO_FLEET, page({ more: true, throughSeq: 501 }));
    expect(nextPageFrom(state, 'm1')).toBe(501);
  });

  it('stops when the server stops saying there is more', () => {
    const state = fold(NO_FLEET, page({ more: false, throughSeq: 1200 }));
    expect(nextPageFrom(state, 'm1')).toBeUndefined();
  });

  it('asks for nothing about a mission it has never read', () => {
    expect(nextPageFrom(NO_FLEET, 'm1')).toBeUndefined();
  });

  it('changes between two pages that both say there is more', () => {
    // The reason this is a SEQUENCE and not a boolean. The component keys an
    // effect on it, and a flag that stays true from one page to the next never
    // changes — so the effect fires once and the client stops a page short
    // believing it is caught up, which is the bug this whole change closes.
    const first = fold(NO_FLEET, page({ more: true, throughSeq: 501 }));
    const second = fold(first, page({ more: true, throughSeq: 1001 }));
    expect(nextPageFrom(first, 'm1')).not.toBe(nextPageFrom(second, 'm1'));
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
