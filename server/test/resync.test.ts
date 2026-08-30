import { describe, expect, it } from 'vitest';
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
  });
});
