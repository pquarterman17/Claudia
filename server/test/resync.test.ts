import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_PAGE, MAX_PAGE } from '../src/store/events.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';
import {
  coalesceSnapshots,
  isOverwhelmed,
  planResync,
  replayIsUsable,
  type ResyncBounds,
} from '../src/fleet/resync.js';

/**
 * The cases worth pinning are the ones where a partial answer would look
 * correct: a client that fell behind the pruning window, or one ahead of the
 * log. Both produce a timeline with a hole that nobody ever notices, which is
 * worse than a visible reload.
 */

const BOUNDS: ResyncBounds = { oldestSeq: 100, newestSeq: 200, maxBatch: 50 };

const dir = mkdtempSync(join(tmpdir(), 'claudia-resync-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const fleet of opened) fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

function store(): FleetStore {
  const result = openFleetStore(join(dir, `db-${opened.length}`, 'fleet.db'));
  if (!result.ok) throw new Error(result.message);
  opened.push(result.value);
  return result.value;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe('planResync', () => {
  it('says nothing to do when the client is current', () => {
    expect(planResync({ lastSeq: 200 }, BOUNDS)).toEqual({ kind: 'up_to_date' });
  });

  it('replays a small gap', () => {
    expect(planResync({ lastSeq: 190 }, BOUNDS)).toEqual({
      kind: 'replay',
      fromSeq: 191,
      toSeq: 200,
      more: false,
    });
  });

  it('caps a replay at the batch size and says there is more', () => {
    expect(planResync({ lastSeq: 100 }, BOUNDS)).toEqual({
      kind: 'replay',
      fromSeq: 101,
      toSeq: 150,
      more: true,
    });
  });

  it('sends a snapshot when the missing events were pruned', () => {
    // The case a "last N events" design gets silently wrong.
    const plan = planResync({ lastSeq: 50 }, BOUNDS);
    expect(plan.kind).toBe('snapshot');
    expect(plan.kind === 'snapshot' && plan.reason).toContain('100');
  });

  it('replays from exactly the oldest kept event', () => {
    // Boundary: lastSeq 99 means the client needs 100, which is still held.
    expect(planResync({ lastSeq: 99 }, BOUNDS)).toMatchObject({ kind: 'replay', fromSeq: 100 });
  });

  it('sends a snapshot to a client that is ahead of the log', () => {
    // The store was rebuilt underneath it, or it is talking to a different
    // server than it thinks.
    expect(planResync({ lastSeq: 300 }, BOUNDS).kind).toBe('snapshot');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('sends a snapshot for the impossible sequence %s', (lastSeq) => {
    expect(planResync({ lastSeq }, BOUNDS).kind).toBe('snapshot');
  });

  it('gives a fresh client everything it can, from the start', () => {
    const plan = planResync({ lastSeq: 0 }, { oldestSeq: 1, newestSeq: 10, maxBatch: 50 });
    expect(plan).toEqual({ kind: 'replay', fromSeq: 1, toSeq: 10, more: false });
  });

  it('is up to date on an empty log', () => {
    expect(planResync({ lastSeq: 0 }, { oldestSeq: 0, newestSeq: 0, maxBatch: 50 })).toEqual({ kind: 'up_to_date' });
  });
});

describe('coalesceSnapshots', () => {
  it('keeps only the newest update per key', () => {
    const updates = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'a', v: 2 },
    ];
    expect(coalesceSnapshots(updates, (u) => u.id)).toEqual([
      { id: 'b', v: 1 },
      { id: 'a', v: 2 },
    ]);
  });

  it('leaves a client in the same place as applying every update', () => {
    // The property that makes dropping updates safe at all.
    const updates = [
      { id: 'a', v: 1 },
      { id: 'a', v: 2 },
      { id: 'b', v: 1 },
      { id: 'a', v: 3 },
      { id: 'b', v: 2 },
    ];
    const apply = (list: typeof updates) => {
      const state = new Map<string, number>();
      for (const u of list) state.set(u.id, u.v);
      return [...state.entries()].sort();
    };
    expect(apply(coalesceSnapshots(updates, (u) => u.id))).toEqual(apply(updates));
  });

  it('changes nothing when every update is about a different thing', () => {
    const updates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(coalesceSnapshots(updates, (u) => u.id)).toEqual(updates);
  });

  it('handles an empty burst', () => {
    expect(coalesceSnapshots([], () => 'k')).toEqual([]);
  });
});

describe('isOverwhelmed', () => {
  it('drops a socket past its limit', () => {
    // An undrained queue is unbounded server memory, and the process that
    // dies is the one running everybody's sessions.
    expect(isOverwhelmed(1_000_001, 1_000_000)).toBe(true);
  });

  it('leaves a socket exactly at its limit alone', () => {
    expect(isOverwhelmed(1_000_000, 1_000_000)).toBe(false);
  });
});

describe('unusable bounds', () => {
  it.each([0, -1, 1.5, Number.NaN])('sends a snapshot rather than replaying with maxBatch %s', (maxBatch) => {
    // Found in review: a batch size below one produced toSeq = fromSeq - 1, an
    // empty range that looks valid and never advances.
    expect(planResync({ lastSeq: 100 }, { ...BOUNDS, maxBatch }).kind).toBe('snapshot');
  });

  it('sends a snapshot when the log bounds are inverted', () => {
    expect(planResync({ lastSeq: 5 }, { oldestSeq: 200, newestSeq: 100, maxBatch: 50 }).kind).toBe('snapshot');
  });

  it('sends a snapshot for a non-integer client sequence', () => {
    expect(planResync({ lastSeq: 1.5 }, BOUNDS).kind).toBe('snapshot');
  });
});

describe('replayIsUsable on a filtered stream', () => {
  it('accepts the gaps another mission leaves behind', () => {
    // Found in review: seq is global, so a per-mission read skips every number
    // another mission wrote. Demanding contiguity rejected every healthy read
    // and would have forced a snapshot on every resync — invisible until a
    // second mission existed.
    expect(replayIsUsable([101, 104, 109], 101, 110, 'filtered')).toBe(true);
  });

  it('still rejects a batch out of order', () => {
    expect(replayIsUsable([104, 101], 101, 110, 'filtered')).toBe(false);
  });

  it('still rejects a batch outside the window', () => {
    expect(replayIsUsable([99], 101, 110, 'filtered')).toBe(false);
    expect(replayIsUsable([111], 101, 110, 'filtered')).toBe(false);
  });

  it('rejects a repeated sequence number', () => {
    expect(replayIsUsable([101, 101], 101, 110, 'filtered')).toBe(false);
  });

  it('accepts an empty batch, because a mission may have written nothing', () => {
    expect(replayIsUsable([], 101, 110, 'filtered')).toBe(true);
  });
});

describe('replayIsUsable', () => {
  it('accepts exactly the range that was planned', () => {
    expect(replayIsUsable([101, 102, 103], 101, 103)).toBe(true);
  });

  it('rejects a batch with a hole in it', () => {
    // Pruning between planning and fetching. Handing this over as contiguous
    // is the same silent gap the snapshot path exists to avoid.
    expect(replayIsUsable([101, 103], 101, 103)).toBe(false);
  });

  it('rejects a short batch', () => {
    expect(replayIsUsable([101, 102], 101, 103)).toBe(false);
  });

  it('rejects a batch that starts somewhere else', () => {
    expect(replayIsUsable([102, 103, 104], 101, 103)).toBe(false);
  });

  it('rejects an inverted range', () => {
    expect(replayIsUsable([], 103, 101)).toBe(false);
    expect(replayIsUsable([], 103, 101, 'filtered')).toBe(false);
  });

  it('rejects a global batch with a hole, which filtered would accept', () => {
    // The whole reason the two modes exist as separate answers.
    expect(replayIsUsable([101, 103], 101, 103)).toBe(false);
    expect(replayIsUsable([101, 103], 101, 103, 'filtered')).toBe(true);
  });
});

describe('the window and the read cannot disagree', () => {
  /**
   * Found by audit, and it is the sharpest edge on the filtered path: nothing
   * in `replayIsUsable` can tell a short batch caused by the store's page
   * limit from one caused by another mission's events. So the limit stopped
   * being a second number a caller keeps equal to the window by hand.
   */
  it('reads exactly the window that was planned, however large', () => {
    const fleet = store();
    for (let i = 0; i < 1200; i++) {
      unwrap(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'tick', payload: { i } }));
    }
    const plan = planResync({ lastSeq: 0 }, { oldestSeq: 1, newestSeq: 1200, maxBatch: 1200 });
    expect(plan).toMatchObject({ kind: 'replay', fromSeq: 1, toSeq: 1200, more: false });
    if (plan.kind !== 'replay') return;

    // The old shape of this call: a window of 1200 read with the default page.
    expect(unwrap(fleet.events.sinceForMission('m1', 0))).toHaveLength(DEFAULT_PAGE);

    const batch = unwrap(fleet.events.replay({ missionId: 'm1', fromSeq: plan.fromSeq, toSeq: plan.toSeq }));
    expect(batch).toHaveLength(1200);
    expect(replayIsUsable(batch.map((e) => e.seq), plan.fromSeq, plan.toSeq, 'filtered')).toBe(true);
  });

  it('refuses a window larger than the log will ever return at once', () => {
    // Better a named failure than a batch quietly one page long.
    const fleet = store();
    const refused = fleet.events.replay({ fromSeq: 1, toSeq: MAX_PAGE + 1 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain(String(MAX_PAGE));
  });

  it('refuses a window that is not one', () => {
    const fleet = store();
    for (const window of [
      { fromSeq: 10, toSeq: 1 },
      { fromSeq: Number.NaN, toSeq: 5 },
      { fromSeq: 1, toSeq: 1.5 },
    ]) {
      expect(fleet.events.replay(window).ok).toBe(false);
    }
  });

  it('narrows to one mission without narrowing the window it promised', () => {
    const fleet = store();
    for (let i = 0; i < 10; i++) {
      unwrap(fleet.events.append({ missionId: i % 2 === 0 ? 'm1' : 'm2', actor: 'system', kind: 'tick', payload: {} }));
    }
    const batch = unwrap(fleet.events.replay({ missionId: 'm1', fromSeq: 1, toSeq: 10 }));
    expect(batch.map((e) => e.seq)).toEqual([1, 3, 5, 7, 9]);
    // The holes are other missions', which is the whole reason the filtered
    // mode exists and the reason completeness cannot be checked here.
    expect(replayIsUsable(batch.map((e) => e.seq), 1, 10, 'filtered')).toBe(true);
    expect(replayIsUsable(batch.map((e) => e.seq), 1, 10)).toBe(false);
  });
});

describe('the plan and the reader agree on how big a window can be', () => {
  it('serves a window planned at exactly the reader ceiling', () => {
    const fleet = store();
    const plan = planResync({ lastSeq: 0 }, { oldestSeq: 1, newestSeq: 100_000, maxBatch: MAX_PAGE });
    expect(plan).toMatchObject({ kind: 'replay', fromSeq: 1, toSeq: MAX_PAGE, more: true });
    if (plan.kind !== 'replay') return;
    expect(fleet.events.replay({ fromSeq: plan.fromSeq, toSeq: plan.toSeq }).ok).toBe(true);
  });

  it('fails loudly, not silently, when a caller plans a bigger one', () => {
    // These are two numbers a caller has to keep in step, and the failure mode
    // if they drift must be a named refusal rather than a short batch — a short
    // batch is the silent hole this whole module exists to prevent.
    const fleet = store();
    const plan = planResync({ lastSeq: 0 }, { oldestSeq: 1, newestSeq: 100_000, maxBatch: MAX_PAGE + 1 });
    expect(plan).toMatchObject({ kind: 'replay', toSeq: MAX_PAGE + 1 });
    if (plan.kind !== 'replay') return;
    const read = fleet.events.replay({ fromSeq: plan.fromSeq, toSeq: plan.toSeq });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.message).toContain(String(MAX_PAGE));
  });
});
