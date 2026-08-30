import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
