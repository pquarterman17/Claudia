import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetEvent, ServerEvent } from '@claudia/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { handleFleetCommand } from '../src/fleet/commands.js';
import { DEFAULT_PAGE } from '../src/store/events.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * A mission's timeline, when its log is longer than one page.
 *
 * The version this replaces asked `sinceForMission(id, 0)` and sent whatever
 * came back. That reader defaults to 500 rows ORDERED ASCENDING, so a client
 * with a 1,200-event log was handed events 1–500 — the OLDEST page — with no
 * indication there were 700 more. The board kept the newest 200 of those and
 * rendered events 301–500 as the current state of the mission.
 *
 * `resync.ts` was written to prevent exactly that and was imported by nothing.
 * Its own comment calls the failure "a 700-event hole, which is the exact
 * silent gap the whole resync design exists to prevent".
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-timeline-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function fleet(): { store: FleetStore; missionId: string } {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  opened.push(boot.store);
  const mission = boot.store.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  return { store: boot.store, missionId: mission.value.id };
}

function fill(store: FleetStore, missionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const appended = store.events.append({ missionId, actor: 'system', kind: `e${i}`, payload: { i } });
    if (!appended.ok) throw new Error(appended.message);
  }
}

interface Page {
  events: FleetEvent[];
  elided: number;
  more: boolean;
  throughSeq: number;
  reset?: string;
}

function ask(store: FleetStore, missionId: string, afterSeq: number): Page {
  const out: ServerEvent[] = handleFleetCommand({ type: 'get_fleet_events', missionId, afterSeq }, store);
  const found = out.find((e) => e.type === 'fleet_events');
  if (found?.type !== 'fleet_events') throw new Error(`no page came back: ${JSON.stringify(out)}`);
  return {
    events: found.events,
    elided: found.elided,
    more: found.more,
    throughSeq: found.throughSeq,
    ...(found.reset ? { reset: found.reset } : {}),
  };
}

const seqs = (page: Page): number[] => page.events.map((e) => e.seq);

describe('a log longer than one page', () => {
  it('opens on the NEWEST events, not the oldest', () => {
    // The regression, stated as the property it broke. A board showing a
    // mission's history must show what just happened, not what happened first.
    const { store, missionId } = fleet();
    fill(store, missionId, 1200);

    const page = ask(store, missionId, 0);
    expect(page.events).toHaveLength(DEFAULT_PAGE);
    expect(seqs(page)[0]).toBe(1200 - DEFAULT_PAGE + 1);
    expect(seqs(page).at(-1)).toBe(1200);
  });

  it('says how many it did not send, instead of saying nothing', () => {
    const { store, missionId } = fleet();
    fill(store, missionId, 1200);
    expect(ask(store, missionId, 0).elided).toBe(1200 - DEFAULT_PAGE);
  });

  it('sends everything, and no page flag, when the log fits', () => {
    const { store, missionId } = fleet();
    fill(store, missionId, 12);
    const page = ask(store, missionId, 0);
    expect(page.events).toHaveLength(12);
    expect(page.elided).toBe(0);
    expect(page.more).toBe(false);
  });

  it('answers an empty log without inventing a page', () => {
    const { store, missionId } = fleet();
    const page = ask(store, missionId, 0);
    expect(page.events).toEqual([]);
    expect(page.elided).toBe(0);
    expect(page.more).toBe(false);
  });
});

describe('catching up from a cursor', () => {
  it('sends only the gap', () => {
    const { store, missionId } = fleet();
    fill(store, missionId, 40);
    const page = ask(store, missionId, 30);
    expect(seqs(page)).toEqual([31, 32, 33, 34, 35, 36, 37, 38, 39, 40]);
  });

  it('says nothing is owed when the client is level with the log', () => {
    const { store, missionId } = fleet();
    fill(store, missionId, 40);
    const page = ask(store, missionId, 40);
    expect(page.events).toEqual([]);
    expect(page.more).toBe(false);
  });

  it('admits a gap bigger than a page is not finished', () => {
    // The half that makes the client keep asking. Without it the board stops a
    // page short of the present and believes it is caught up.
    const { store, missionId } = fleet();
    fill(store, missionId, 1200);
    const first = ask(store, missionId, 1);
    expect(first.more).toBe(true);
    expect(first.events).toHaveLength(DEFAULT_PAGE);
    expect(seqs(first)[0]).toBe(2);
  });

  it('reaches the end by paging, with no hole between the pages', () => {
    const { store, missionId } = fleet();
    fill(store, missionId, 1200);

    const seen: number[] = [];
    let cursor = 1;
    for (let round = 0; round < 10; round++) {
      const page = ask(store, missionId, cursor);
      seen.push(...seqs(page));
      if (!page.more) break;
      // From the WINDOW's end, which is what a client does. Every round
      // strictly advances, so this cannot spin.
      expect(page.throughSeq).toBeGreaterThan(cursor);
      cursor = page.throughSeq;
    }
    // 2..1200 inclusive, contiguous, in order, nothing repeated.
    expect(seen).toHaveLength(1199);
    expect(seen[0]).toBe(2);
    expect(seen.at(-1)).toBe(1200);
    expect(seen.every((seq, i) => i === 0 || seq === (seen[i - 1] ?? 0) + 1)).toBe(true);
  });
});

describe('a cursor that cannot be replayed', () => {
  it('tells the client to start again rather than splicing onto a lie', () => {
    // Ahead of the log: the store was rebuilt, or this is a different server
    // than the client thinks. A replay here would look continuous and be two
    // unrelated histories joined together.
    const { store, missionId } = fleet();
    fill(store, missionId, 40);
    const page = ask(store, missionId, 5000);
    expect(page.reset).toBeTruthy();
    expect(seqs(page).at(-1)).toBe(40);
  });

  it('does not reset a client whose cursor is merely old', () => {
    const { store, missionId } = fleet();
    fill(store, missionId, 1200);
    expect(ask(store, missionId, 1).reset).toBeUndefined();
  });
});

describe('bounds are this mission’s own', () => {
  it('does not count another mission’s events as this one’s history', () => {
    // The trap `resync.ts` names: a mission's sequences are sparse, because
    // every event another mission wrote takes a number this one skips. Bounds
    // read globally would put a client's cursor past a log with nothing after
    // it, and the range spans events that are not this mission's at all.
    const a = fleet();
    const b = a.store.missions.create({ name: 'other', body: '', cwd: '/repo' });
    if (!b.ok) throw new Error(b.message);
    fill(a.store, a.missionId, 5);
    fill(a.store, b.value.id, 600);
    fill(a.store, a.missionId, 5);

    const page = ask(a.store, a.missionId, 0);
    expect(page.events).toHaveLength(10);
    expect(page.elided).toBe(0);
    expect(page.more).toBe(false);
    expect(page.events.every((e) => e.missionId === a.missionId)).toBe(true);

    // Catching up across the same sparseness. A page is a SEQUENCE window, so
    // one round can legitimately return four of this mission's events out of a
    // 500-wide span — which is why it says `more` rather than pretending to be
    // the end. The property that matters is that paging reaches the end with
    // nothing missing, not that it does so in one round.
    const seen: number[] = [];
    let cursor = seqs(page)[0] ?? 0;
    // Two rounds is the point: without `throughSeq` this needed six hundred.
    for (let round = 0; round < 5; round++) {
      const next = ask(a.store, a.missionId, cursor);
      seen.push(...seqs(next));
      if (!next.more) break;
      // A window holding none of this mission's events still advances, because
      // the cursor comes from the window rather than from the events in it.
      expect(next.throughSeq).toBeGreaterThan(cursor);
      cursor = next.throughSeq;
    }
    expect(seen).toEqual([2, 3, 4, 5, 606, 607, 608, 609, 610]);
  });
});
