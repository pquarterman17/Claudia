import { AGENT_KINDS } from '@claudia/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { FleetPulser, type LaunchOrder, type SessionFacts } from '../src/fleet/pulse.js';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { applyMigrations, MIGRATIONS, schemaVersion } from '../src/store/migrations.js';
import { openFleetStore, type FleetStore } from '../src/store/index.js';

/**
 * Which harness a mission's children run on.
 *
 * The roster has been two since Codex landed and `ChildRun.agent` has always
 * been stored, but nothing chose it: the pulse wrote `'claude'` from a constant
 * and the launcher launched `'claude'` from another one, so a repository better
 * served by the other harness had no way to say so. The value now travels —
 * mission row, reservation, started child — and every joint on that path is
 * somewhere it could be dropped, or read from the wrong place.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-mission-agent-'));
const stores: FleetStore[] = [];
const dbs: DatabaseSync[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const db of dbs) closeFleetDb(db);
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function fleet(): FleetStore {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  stores.push(boot.store);
  return boot.store;
}

const NO_SESSIONS = (): ReadonlyMap<string, SessionFacts> => new Map();

describe('a mission names its harness', () => {
  it('runs on Claude when nobody said otherwise', () => {
    const store = fleet();
    const made = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    expect(made.ok && made.value.agent).toBe('claude');
  });

  it('keeps the choice across a read', () => {
    const store = fleet();
    const made = store.missions.create({ name: 'm', body: '', cwd: '/repo', agent: 'codex' });
    if (!made.ok) throw new Error(made.message);
    const read = store.missions.get(made.value.id);
    expect(read.ok && read.value?.agent).toBe('codex');
  });

  it('refuses an agent that is not on the roster, by name', () => {
    // A cast is a claim, and the lesson from `child_runs.agent` — which
    // shipped without a check and accepted `'gemini'` — is that the claim has
    // to be checked where the write happens.
    const store = fleet();
    const made = store.missions.create({
      name: 'm',
      body: '',
      cwd: '/repo',
      agent: 'gemini' as (typeof AGENT_KINDS)[number],
    });
    expect(made.ok).toBe(false);
    expect(made.ok ? '' : made.message).toContain('gemini');
  });

  it('refuses a hand-written UPDATE to an agent off the roster', () => {
    // The database has to hold this line too. Anyone with the file has a
    // sqlite3 prompt, and a value that cannot be stored is one the reader
    // never has to be strict about.
    const store = fleet();
    const made = store.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!made.ok) throw new Error(made.message);
    expect(() => store.db.prepare('UPDATE missions SET agent = ? WHERE id = ?').run('gemini', made.value.id)).toThrow();
  });
});

describe('a database written before missions had an agent', () => {
  it('reads back as Claude, which is what those missions actually ran on', () => {
    // The default is not a guess. Every mission written before this column
    // existed was launched by a constant that said `claude`, so recording that
    // is the only answer that is true of the rows already on disk.
    // Opened against the migration list MINUS this one, which is what that
    // override on `openFleetDb` exists for: the real list up to the version
    // before, rather than a synthetic schema that only resembles it.
    const path = join(dir, 'older', 'fleet.db');
    const before = MIGRATIONS.filter((m) => m.name !== 'mission-agent');
    const opened = openFleetDb(path, before);
    if (!opened.ok) throw new Error(opened.message);
    const db = opened.value;
    dbs.push(db);

    // Written the old way: there is no agent column to fill in yet.
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m-old', 'old', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();

    applyMigrations(db);
    expect(schemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    const row = db.prepare("SELECT agent FROM missions WHERE id = 'm-old'").get();
    expect(row?.['agent']).toBe('claude');
  });

  it('still opens through the normal path afterwards', () => {
    // The migration is only worth anything if a file that has run it is a file
    // the repositories can read.
    const store = openFleetStore(join(dir, 'older', 'fleet.db'));
    if (!store.ok) throw new Error(store.message);
    stores.push(store.value);
    const read = store.value.missions.get('m-old');
    expect(read.ok && read.value?.agent).toBe('claude');
  });
});

describe('the choice reaches the child', () => {
  function readyTask(store: FleetStore, missionId: string) {
    const task = store.tasks.create({ missionId, title: 't', description: '', cwd: '/repo' });
    if (!task.ok) throw new Error(task.message);
    const ready = store.tasks.setStatus(task.value.id, 'ready');
    if (!ready.ok) throw new Error(ready.message);
    return ready.value;
  }

  async function pulseOnce(agent: 'claude' | 'codex'): Promise<{ store: FleetStore; orders: LaunchOrder[] }> {
    const store = fleet();
    const made = store.missions.create({ name: 'm', body: '', cwd: '/repo', agent });
    if (!made.ok) throw new Error(made.message);
    const watched = store.missions.setWatch(made.value.id, 'watching');
    if (!watched.ok) throw new Error(watched.message);
    readyTask(store, made.value.id);

    const orders: LaunchOrder[] = [];
    await new FleetPulser({
      store,
      policy: { maxChildren: 4, maxAttempts: 3 },
      observeSessions: NO_SESSIONS,
      launch: async (order) => {
        orders.push(order);
        return true;
      },
    }).tick();
    return { store, orders };
  }

  it('reserves the attempt on the harness the mission chose', async () => {
    const { store, orders } = await pulseOnce('codex');
    expect(orders[0]?.agent).toBe('codex');
    // And durably, not only in the order: the run row is what a restart, a
    // retry and the watchdog all read back.
    const run = store.runs.get(orders[0]!.runId);
    expect(run.ok && run.value?.agent).toBe('codex');
  });

  it('still reserves on Claude for a mission that did not choose', async () => {
    const { orders } = await pulseOnce('claude');
    expect(orders[0]?.agent).toBe('claude');
  });
});
