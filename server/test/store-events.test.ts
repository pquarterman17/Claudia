import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transact } from '../src/store/db.js';
import { FleetEventLog } from '../src/store/events.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-store-events-'));

/** Closed before the directory goes: an open handle makes unlink fail with
 * EBUSY on Windows, and the whole file fails in teardown with every test
 * reported as passing. */
const opened: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const fleet of opened) fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function store(name = `db-${counter++}`): FleetStore {
  const result = openFleetStore(join(dir, name, 'fleet.db'));
  if (!result.ok) throw new Error(result.message);
  opened.push(result.value);
  return result.value;
}

/** Unwraps a result in a test, where a failure is simply the test failing. */
function value<T>(result: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

describe('the fleet event log', () => {
  it('assigns monotonic sequence numbers across many appends', () => {
    const fleet = store();
    const seqs: number[] = [];
    for (let i = 0; i < 250; i++) {
      const appended = value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'tick', payload: { i } }));
      seqs.push(appended.event.seq);
    }
    expect(seqs).toEqual(seqs.slice().sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(value(fleet.events.latestSeq())).toBe(seqs[seqs.length - 1]);
    fleet.close();
  });

  it('keeps the sequence climbing across missions and restarts', () => {
    const path = 'restart';
    const first = store(path);
    const a = value(first.events.append({ missionId: 'm1', actor: 'human', kind: 'created', payload: null }));
    const b = value(first.events.append({ missionId: 'm2', actor: 'manager', kind: 'dispatch', payload: null }));
    expect(b.event.seq).toBeGreaterThan(a.event.seq);
    first.close();

    const second = store(path);
    const c = value(second.events.append({ missionId: 'm1', actor: 'child', kind: 'report', payload: null }));
    expect(c.event.seq).toBeGreaterThan(b.event.seq);
    // The whole history is still there, in order.
    expect(value(second.events.since(0)).map((event) => event.seq)).toEqual([a.event.seq, b.event.seq, c.event.seq]);
    second.close();
  });

  it('returns the existing event when an idempotency key repeats', () => {
    const fleet = store();
    const first = value(
      fleet.events.append({ missionId: 'm1', actor: 'manager', kind: 'dispatch', payload: { task: 't1' }, idempotencyKey: 'pulse-7' }),
    );
    // The same pulse, arriving again: the payload differs, and the stored one wins.
    const second = value(
      fleet.events.append({ missionId: 'm1', actor: 'manager', kind: 'dispatch', payload: { task: 'different' }, idempotencyKey: 'pulse-7' }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.event.seq).toBe(first.event.seq);
    expect(second.event.payload).toEqual({ task: 't1' });
    expect(value(fleet.events.since(0))).toHaveLength(1);
    fleet.close();
  });

  it('dedupes by key across a restart, not just within one process', () => {
    const path = 'dedupe-restart';
    const first = store(path);
    const original = value(
      first.events.append({ missionId: 'm1', actor: 'manager', kind: 'dispatch', payload: 1, idempotencyKey: 'k' }),
    );
    first.close();

    const second = store(path);
    const repeat = value(
      second.events.append({ missionId: 'm1', actor: 'manager', kind: 'dispatch', payload: 2, idempotencyKey: 'k' }),
    );
    expect(repeat.created).toBe(false);
    expect(repeat.event.seq).toBe(original.event.seq);
    second.close();
  });

  it('never dedupes events without a key', () => {
    const fleet = store();
    const first = value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'noise', payload: null }));
    const second = value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'noise', payload: null }));
    expect(second.event.seq).not.toBe(first.event.seq);
    expect(first.event.idempotencyKey).toBeUndefined();
    fleet.close();
  });

  it('reads back a page after a sequence, for a client catching up', () => {
    const fleet = store();
    for (let i = 0; i < 20; i++) {
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'tick', payload: { i } }));
    }
    const page = value(fleet.events.since(5, 4));
    expect(page.map((event) => event.seq)).toEqual([6, 7, 8, 9]);
    expect(value(fleet.events.since(19))).toHaveLength(1);
    expect(value(fleet.events.since(20))).toEqual([]);
    fleet.close();
  });

  it('clamps a nonsense or unbounded page size', () => {
    const fleet = store();
    for (let i = 0; i < 5; i++) {
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'tick', payload: null }));
    }
    expect(value(fleet.events.since(0, -1))).toHaveLength(5);
    expect(value(fleet.events.since(0, Number.POSITIVE_INFINITY))).toHaveLength(5);
    fleet.close();
  });

  it('narrows to one mission without breaking the global sequence', () => {
    const fleet = store();
    value(fleet.events.append({ missionId: 'm1', actor: 'human', kind: 'a', payload: null }));
    value(fleet.events.append({ missionId: 'm2', actor: 'human', kind: 'b', payload: null }));
    value(fleet.events.append({ missionId: 'm1', actor: 'human', kind: 'c', payload: null }));

    const mine = value(fleet.events.sinceForMission('m1'));
    expect(mine.map((event) => event.kind)).toEqual(['a', 'c']);
    expect(mine.map((event) => event.seq)).toEqual([1, 3]);
    fleet.close();
  });

  it('carries task and run ids so the timeline can filter without the payload', () => {
    const fleet = store();
    value(fleet.events.append({ missionId: 'm1', actor: 'manager', kind: 'dispatch', payload: null, taskId: 't1', runId: 'r1' }));
    value(fleet.events.append({ missionId: 'm1', actor: 'child', kind: 'report', payload: null, taskId: 't1', runId: 'r1' }));
    value(fleet.events.append({ missionId: 'm1', actor: 'human', kind: 'paused', payload: null }));
    value(fleet.events.append({ missionId: 'm1', actor: 'manager', kind: 'dispatch', payload: null, taskId: 't2' }));

    const forTask = value(fleet.events.sinceForTask('t1'));
    expect(forTask.map((event) => event.kind)).toEqual(['dispatch', 'report']);
    expect(forTask.map((event) => event.runId)).toEqual(['r1', 'r1']);
    // A mission-level event keeps both absent rather than inventing a task.
    const missionLevel = value(fleet.events.sinceForMission('m1')).find((event) => event.kind === 'paused');
    expect(missionLevel?.taskId).toBeUndefined();
    expect(missionLevel?.runId).toBeUndefined();
    // Paged from a sequence, like every other read.
    expect(value(fleet.events.sinceForTask('t1', 1)).map((event) => event.kind)).toEqual(['report']);
    fleet.close();
  });

  it('outlives the mission and task it describes', () => {
    // The reason those columns carry no foreign key: deleting a mission must
    // not erase the history of the deletion.
    const fleet = store();
    const mission = value(fleet.missions.create({ name: 'Short-lived', body: 'b', cwd: '/repo' }));
    const task = value(fleet.tasks.create({ missionId: mission.id, title: 'A', description: '', cwd: '/repo' }));
    value(fleet.events.append({ missionId: mission.id, taskId: task.id, actor: 'human', kind: 'created', payload: null }));

    fleet.db.prepare('DELETE FROM missions WHERE id = ?').run(mission.id);
    expect(value(fleet.tasks.get(task.id))).toBeUndefined();
    expect(value(fleet.events.sinceForTask(task.id))).toHaveLength(1);
    fleet.close();
  });

  it('round-trips payloads as JSON and stores them as text', () => {
    const fleet = store();
    const payload = { nested: { list: [1, 'two', null], flag: true } };
    const appended = value(fleet.events.append({ missionId: 'm1', actor: 'child', kind: 'report', payload }));
    expect(value(fleet.events.since(0))[0]?.payload).toEqual(payload);

    // Stored as text, so nothing on the read path can execute it.
    const raw = fleet.db.prepare('SELECT typeof(payload) AS t, payload FROM fleet_events WHERE seq = ?').get(appended.event.seq);
    expect(raw?.['t']).toBe('text');
    expect(raw?.['payload']).toBe(JSON.stringify(payload));
    fleet.close();
  });

  it('keeps an undefined payload storable', () => {
    const fleet = store();
    const appended = value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'empty', payload: undefined }));
    expect(appended.event.payload).toBe(null);
    fleet.close();
  });

  it('refuses a payload that cannot be JSON', () => {
    const fleet = store();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const result = fleet.events.append({ missionId: 'm1', actor: 'child', kind: 'bad', payload: circular });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/JSON/);
    // The refusal left nothing behind.
    expect(value(fleet.events.since(0))).toEqual([]);
    fleet.close();
  });

  it('reports a dead connection as a result rather than throwing', () => {
    // What a websocket handler must never see: an exception out of the store.
    const fleet = store();
    fleet.close();
    const log = new FleetEventLog(fleet.db);
    expect(() => log.append({ missionId: 'm1', actor: 'system', kind: 'after-close', payload: null })).not.toThrow();
    expect(log.append({ missionId: 'm1', actor: 'system', kind: 'after-close', payload: null }).ok).toBe(false);
    expect(log.since(0).ok).toBe(false);
    expect(log.latestSeq().ok).toBe(false);
  });
});

describe('a sequence number nobody can act on too early', () => {
  /**
   * `seq` is AUTOINCREMENT so a client holding "I have seen up to N" can never
   * be shown a different event at N or below. sqlite_sequence is an ordinary
   * table, though, so its bump rolls back with everything else — which means
   * the number is only true once the transaction that produced it commits.
   */
  it('reuses a sequence released by a rolled-back step, which is why publishing waits', () => {
    // The defect itself, pinned as the reason the queue exists. If SQLite ever
    // stops reusing the number this test fails and onAppended can be simplified
    // away; until then it cannot.
    const fleet = store();
    let handedOut = 0;
    const step = transact(fleet.db, 'one larger atomic step', () => {
      const appended = value(
        fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'dispatch', payload: {} }),
      );
      handedOut = appended.event.seq;
      throw new Error('the step failed after the event was appended');
    });
    expect(step.ok).toBe(false);

    const next = value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'task_failed', payload: {} }));
    expect(next.event.seq).toBe(handedOut);
    expect(next.event.kind).not.toBe('dispatch');
  });

  it('tells a subscriber nothing about an event that never landed', () => {
    const fleet = store();
    const seen: string[] = [];
    fleet.events.onAppended((event) => seen.push(`${event.seq}:${event.kind}`));

    transact(fleet.db, 'a step that fails', () => {
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'dispatch', payload: {} }));
      throw new Error('failed after appending');
    });
    expect(seen).toEqual([]);

    value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'task_failed', payload: {} }));
    // The number the rolled-back append was given, now carrying the event that
    // really has it. A subscriber told the first one would have been wrong.
    expect(seen).toEqual(['1:task_failed']);
  });

  it('holds a subscriber until the OUTERMOST step commits, not the inner one', () => {
    const fleet = store();
    const seen: number[] = [];
    fleet.events.onAppended((event) => seen.push(event.seq));

    const outcome = transact(fleet.db, 'outer', () => {
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {} }));
      expect(seen, 'the inner append committed a savepoint, not the transaction').toEqual([]);
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'b', payload: {} }));
      expect(seen).toEqual([]);
      return 'done';
    });
    expect(outcome).toEqual({ ok: true, value: 'done' });
    expect(seen).toEqual([1, 2]);
  });

  it('drops only what the failed inner step registered', () => {
    // A savepoint rollback undoes its own work and leaves the outer transaction
    // open and intact, which is what a caller that means to carry on after a
    // refused step needs. The queue has to behave the same way.
    const fleet = store();
    const seen: string[] = [];
    fleet.events.onAppended((event) => seen.push(event.kind));

    transact(fleet.db, 'outer', () => {
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'kept', payload: {} }));
      const inner = transact(fleet.db, 'inner', () => {
        value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'dropped', payload: {} }));
        throw new Error('inner step refused');
      });
      expect(inner.ok).toBe(false);
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'also-kept', payload: {} }));
      return true;
    });
    expect(seen).toEqual(['kept', 'also-kept']);
    expect(value(fleet.events.since(0)).map((e) => e.kind)).toEqual(['kept', 'also-kept']);
  });

  it('fires immediately when there is no transaction to wait for', () => {
    const fleet = store();
    const seen: number[] = [];
    fleet.events.onAppended((event) => seen.push(event.seq));
    // append() opens its own transaction and commits it, so by the time it
    // returns the work is durable and the subscriber has already been told.
    const appended = value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {} }));
    expect(seen).toEqual([appended.event.seq]);
  });

  it('says nothing when an append was deduplicated, because nothing was appended', () => {
    const fleet = store();
    const seen: number[] = [];
    fleet.events.onAppended((event) => seen.push(event.seq));
    const first = value(
      fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {}, idempotencyKey: 'k' }),
    );
    const again = value(
      fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {}, idempotencyKey: 'k' }),
    );
    expect(again.created).toBe(false);
    expect(seen).toEqual([first.event.seq]);
  });

  it('survives a subscriber that throws, and still tells the others', () => {
    // These run on the write path. A broken listener must not be able to fail
    // the append that already committed.
    const fleet = store();
    const seen: number[] = [];
    fleet.events.onAppended(() => {
      throw new Error('a subscriber blew up');
    });
    fleet.events.onAppended((event) => seen.push(event.seq));
    const appended = fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {} });
    expect(appended.ok).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('stops telling a subscriber that unsubscribed', () => {
    const fleet = store();
    const seen: number[] = [];
    const off = fleet.events.onAppended((event) => seen.push(event.seq));
    value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {} }));
    off();
    value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'b', payload: {} }));
    expect(seen).toHaveLength(1);
  });
});

describe('a transaction this module did not open', () => {
  it('refuses as a VALUE, because this guard runs before anything wraps it', () => {
    // The store's contract is that no method throws at a caller reached from a
    // websocket handler. This check sits ahead of `transact`, so `refuse()`
    // here escaped uncaught — caught by the dead-connection test next door.
    const fleet = store();
    fleet.db.exec('BEGIN IMMEDIATE');
    let threw = false;
    let result;
    try {
      result = fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'a', payload: {} });
    } catch {
      threw = true;
    }
    fleet.db.exec('ROLLBACK');
    expect(threw).toBe(false);
    expect(result?.ok).toBe(false);
  });

  it('does not publish from inside one either, and never publishes it LATER', () => {
    // The bug this replaces was in the first version of the fix, and its own
    // test missed it by checking the moment rather than the consequence: the
    // callback was QUEUED inside the foreign transaction, survived the
    // rollback, and fired on the next unrelated commit. A subscriber was told
    // seq 1 was a rolled-back event, then told seq 1 was the real event that
    // took the number — two different events at one sequence, which is exactly
    // what deferring was written to prevent.
    const fleet = store();
    const seen: string[] = [];
    fleet.events.onAppended((event) => seen.push(`${event.seq}:${event.kind}`));

    fleet.db.exec('BEGIN IMMEDIATE');
    expect(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'rolled-back', payload: {} }).ok).toBe(false);
    expect(seen, 'nothing was appended, so nothing is pending').toEqual([]);
    fleet.db.exec('ROLLBACK');
    expect(seen).toEqual([]);

    // The step that caught it: any later commit at all.
    value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'real', payload: {} }));
    expect(seen).toEqual(['1:real']);
    expect(value(fleet.events.since(0)).map((e) => e.kind)).toEqual(['real']);
  });

  it('publishes an event a LISTENER appends, rather than storing it in silence', () => {
    // Found in review: the drain ran while the depth counter still read 1, so a
    // listener's own append looked nested to a transaction that had already
    // committed — the row was written and its notification dropped. Announced
    // ["1:first"] while the log held ["first", "by-listener"].
    const fleet = store();
    const seen: string[] = [];
    fleet.events.onAppended((event) => {
      seen.push(`${event.seq}:${event.kind}`);
      if (event.kind === 'first') {
        fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'by-listener', payload: {} });
      }
    });
    transact(fleet.db, 'outer', () =>
      value(fleet.events.append({ missionId: 'm1', actor: 'system', kind: 'first', payload: {} })),
    );
    expect(seen).toEqual(['1:first', '2:by-listener']);
    expect(value(fleet.events.since(0)).map((e) => e.kind)).toEqual(['first', 'by-listener']);
  });
});
