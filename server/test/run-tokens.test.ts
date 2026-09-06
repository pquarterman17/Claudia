import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, MIGRATIONS, schemaVersion } from '../src/store/migrations.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

/**
 * What one attempt spent, kept where it outlives the session that spent it.
 *
 * Token spend lives on a session, and a session that has ended has taken its
 * counts with it — so `spendOf` answered NaN and `overBudget` held every
 * mission with a token budget from its first pulse. Permanently: settable,
 * visible, and enforcing a stop rather than a bound, which is the worst shape
 * a limit can take.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-run-tokens-'));
const stores: FleetStore[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const db of dbs) closeFleetDb(db);
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function reserved() {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  stores.push(store);
  const mission = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
  if (!mission.ok) throw new Error(mission.message);
  const task = store.tasks.create({ missionId: mission.value.id, title: 't', description: '', cwd: '/repo' });
  if (!task.ok) throw new Error(task.message);
  const run = store.runs.create({ missionId: mission.value.id, taskId: task.value.id, agent: 'claude', attempt: 1 });
  if (!run.ok) throw new Error(run.message);
  return { store, run: run.value };
}

describe('recording what a run has spent', () => {
  it('starts at nothing spent, because a reservation has not run yet', () => {
    // Zero rather than unknown, and the difference matters: this one IS known.
    // No session exists, so nothing has been charged to it.
    const { run } = reserved();
    expect(run.tokens).toBe(0);
  });

  it('keeps the highest reading rather than the latest', () => {
    // The counts come from a cumulative summary updated at turn end, so a
    // lower number is a stale or partial observation, not a refund. Letting
    // one overwrite a higher figure would make a budget cheaper the longer it
    // is watched.
    const { store, run } = reserved();
    const first = store.runs.recordTokens(run.id, 900);
    expect(first.ok && first.value.tokens).toBe(900);
    const stale = store.runs.recordTokens(run.id, 400);
    expect(stale.ok && stale.value.tokens).toBe(900);
    const grown = store.runs.recordTokens(run.id, 1_500);
    expect(grown.ok && grown.value.tokens).toBe(1_500);
  });

  it('refuses a number that is not a count', () => {
    // An unreadable count has to stay unreadable. Writing NaN as though it
    // were a measurement is how a mission's spend quietly becomes a number
    // nobody can trust.
    const { store, run } = reserved();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(store.runs.recordTokens(run.id, bad).ok, `${bad}`).toBe(false);
    }
    const after = store.runs.get(run.id);
    expect(after.ok && after.value?.tokens).toBe(0);
  });

  it('survives the session, which is the whole point', () => {
    const { store, run } = reserved();
    const attached = store.runs.attachSession(run.id, 'sess-1');
    if (!attached.ok) throw new Error(attached.message);
    const recorded = store.runs.recordTokens(run.id, 4_200);
    if (!recorded.ok) throw new Error(recorded.message);
    // By the route the contract allows: a run reaches `reported` from
    // `running`, never straight from the reservation.
    for (const state of ['running', 'reported'] as const) {
      const moved = store.runs.setState(run.id, state);
      if (!moved.ok) throw new Error(moved.message);
    }

    // Terminal, its session long gone, and the row still says what it cost.
    const after = store.runs.get(run.id);
    expect(after.ok && after.value?.tokens).toBe(4_200);
  });
});

describe('a database written before runs recorded it', () => {
  it('gains the column, and reads back as unmeasured rather than as free', () => {
    const path = join(dir, 'older', 'fleet.db');
    const version = MIGRATIONS.find((m) => m.name === 'run-tokens')?.version ?? 0;
    expect(version).toBeGreaterThan(0);
    const opened = openFleetDb(path, MIGRATIONS.filter((m) => m.version < version));
    if (!opened.ok) throw new Error(opened.message);
    const db = opened.value;
    dbs.push(db);
    // The fixture is only a fixture if it is actually older.
    expect(schemaVersion(db)).toBeLessThan(version);

    const now = Date.now();
    db.prepare(
      `INSERT INTO missions (id,name,body,status,watch,pulse_sec,max_children,cwd,agent,created_at,updated_at)
       VALUES ('m-old','old','','active','paused',60,4,'/repo','claude',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO tasks (id,mission_id,title,description,cwd,status,priority,depends_on,acceptance,created_at,updated_at)
       VALUES ('t-old','m-old','t','','/repo','reported',0,'[]','',?,?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO child_runs (id,mission_id,task_id,agent,attempt,state,started_at)
       VALUES ('r-old','m-old','t-old','claude',1,'reported',?)`,
    ).run(now);

    applyMigrations(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    // NULL, not 0. Those sessions are gone and took their counts with them, so
    // the honest answer is that nobody knows — which `spendOf` turns into a
    // hold rather than into headroom the mission may not have.
    const row = db.prepare("SELECT tokens FROM child_runs WHERE id = 'r-old'").get();
    expect(row?.['tokens']).toBeNull();
  });

  it('reads that run back as unmeasured through the store', () => {
    const store = openFleetStore(join(dir, 'older', 'fleet.db'));
    if (!store.ok) throw new Error(store.message);
    stores.push(store.value);
    const run = store.value.runs.get('r-old');
    expect(run.ok).toBe(true);
    expect(run.ok && run.value?.tokens).toBeUndefined();
  });
});
