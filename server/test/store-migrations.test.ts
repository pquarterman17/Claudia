import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { isSqliteExperimentalWarning } from '../src/store/experimental-warning.js';
import { applyMigrations, latestVersion, MIGRATIONS, schemaVersion, type Migration } from '../src/store/migrations.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-store-mig-'));

/** Closed before the directory goes. An open handle makes unlink fail with
 * EBUSY on Windows, failing the whole file in teardown while every test
 * reports as passing — invisible on Linux, which unlinks open files. */
const opened: DatabaseSync[] = [];
afterAll(() => {
  for (const db of opened) closeFleetDb(db);
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
/** A fresh, migrated database per test, in this file's temp directory. */
function fresh(): DatabaseSync {
  const result = openFleetDb(join(dir, `db-${counter++}`, 'fleet.db'));
  if (!result.ok) throw new Error(result.message);
  opened.push(result.value);
  return result.value;
}

function tables(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row['name']))
    .filter((name) => !name.startsWith('sqlite_'));
}

const NEXT = latestVersion(MIGRATIONS) + 1;

describe('opening the fleet database', () => {
  it('migrates an empty file to the latest version', () => {
    const db = fresh();
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));
    expect(tables(db)).toEqual(['child_runs', 'escalations', 'fleet_events', 'missions', 'tasks', 'worktrees']);
    closeFleetDb(db);
  });

  it('enables foreign keys and WAL', () => {
    const db = fresh();
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
    expect(db.prepare('PRAGMA journal_mode').get()?.['journal_mode']).toBe('wal');
    closeFleetDb(db);
  });

  it('creates the directory rather than requiring one', () => {
    const result = openFleetDb(join(dir, 'not', 'there', 'yet', 'fleet.db'));
    expect(result.ok).toBe(true);
    if (result.ok) opened.push(result.value);
  });

  it('reports an unopenable path as a value, not a throw', () => {
    // A file where a directory needs to be: mkdir fails, and the caller must
    // still get a result it can show rather than an exception in a handler.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const result = openFleetDb(join(blocker, 'fleet.db'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('open the fleet database');
  });

  it('is idempotent: reopening applies nothing', () => {
    const path = join(dir, 'reopen', 'fleet.db');
    const first = openFleetDb(path);
    if (!first.ok) throw new Error(first.message);
    closeFleetDb(first.value);

    const second = openFleetDb(path);
    if (!second.ok) throw new Error(second.message);
    opened.push(second.value);
    expect(applyMigrations(second.value)).toBe(0);
    expect(schemaVersion(second.value)).toBe(latestVersion(MIGRATIONS));
    closeFleetDb(second.value);
  });
});

describe('applyMigrations', () => {
  it('upgrades a database created at an older version, keeping its rows', () => {
    const db = fresh();
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'Old', 'body', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();

    // Appended, never edited into the existing one: the point of the version
    // list is that a later change cannot disturb what already ran.
    const added: Migration = {
      version: NEXT,
      name: 'test-note-column',
      up: (target) => target.exec('ALTER TABLE missions ADD COLUMN note TEXT'),
    };
    expect(applyMigrations(db, [...MIGRATIONS, added])).toBe(1);
    expect(schemaVersion(db)).toBe(NEXT);

    const row = db.prepare('SELECT name, note FROM missions WHERE id = ?').get('m1');
    expect(row?.['name']).toBe('Old');
    expect(row?.['note']).toBe(null);
    closeFleetDb(db);
  });

  it('leaves the version and the schema untouched when a migration fails', () => {
    const db = fresh();
    const broken: Migration = {
      version: NEXT,
      name: 'test-broken',
      up: (target) => {
        target.exec('CREATE TABLE half_applied (id TEXT PRIMARY KEY) STRICT');
        target.exec('THIS IS NOT SQL');
      },
    };
    expect(() => applyMigrations(db, [...MIGRATIONS, broken])).toThrow(/test-broken/);
    // Rolled back whole: the table the migration got as far as creating is gone.
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));
    expect(tables(db)).not.toContain('half_applied');
    closeFleetDb(db);
  });

  it('refuses a file written by a newer build', () => {
    const db = fresh();
    db.exec(`PRAGMA user_version = ${NEXT + 40}`);
    expect(() => applyMigrations(db)).toThrow(/newer than this build/);
    closeFleetDb(db);
  });

  it('refuses a list whose versions do not ascend', () => {
    const db = fresh();
    const duplicate: Migration = { version: 1, name: 'test-duplicate', up: () => {} };
    expect(() => applyMigrations(db, [...MIGRATIONS, duplicate])).toThrow(/ascending/);
    closeFleetDb(db);
  });

  it('surfaces a broken migration through openFleetDb as a result', () => {
    // The same failure, reached the way the server reaches it: a value.
    const path = join(dir, 'newer', 'fleet.db');
    const first = openFleetDb(path);
    if (!first.ok) throw new Error(first.message);
    first.value.exec(`PRAGMA user_version = ${NEXT + 40}`);
    closeFleetDb(first.value);

    const second = openFleetDb(path);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.message).toMatch(/newer than this build/);
  });
});

describe('the SQLite experimental warning', () => {
  it('drops node:sqlite own warning and keeps every other', () => {
    // The exact text Node emits on first load of node:sqlite.
    const sqlite = new Error('SQLite is an experimental feature and might change at any time');
    sqlite.name = 'ExperimentalWarning';
    expect(isSqliteExperimentalWarning(sqlite)).toBe(true);

    const other = new Error('Type stripping is an experimental feature');
    other.name = 'ExperimentalWarning';
    expect(isSqliteExperimentalWarning(other)).toBe(false);

    const deprecation = new Error('SQLite something is deprecated');
    deprecation.name = 'DeprecationWarning';
    expect(isSqliteExperimentalWarning(deprecation)).toBe(false);
  });
});

describe('the escalation-idempotency migration', () => {
  it('upgrades a real version-1 database rather than only a synthetic one', () => {
    // The first genuine second migration, so this is the first time the
    // "migrates from a previous schema" gate is exercised against the real
    // list rather than a test-only migration appended to it.
    const path = join(dir, 'v1-upgrade', 'fleet.db');
    const only = MIGRATIONS.filter((m) => m.version === 1);

    const result = openFleetDb(path, only);
    if (!result.ok) throw new Error(result.message);
    const db = result.value;
    opened.push(db);
    expect(schemaVersion(db)).toBe(1);
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'Old', 'body', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO escalations (id, mission_id, source, request, reason, severity, resolution, created_at)
       VALUES ('e1', 'm1', 'human', 'push', 'because', 'warning', 'pending', 1)`,
    ).run();

    expect(applyMigrations(db)).toBe(1);
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));
    // The pre-existing row survives, with the new column null rather than absent.
    const row = db.prepare('SELECT id, idempotency_key FROM escalations WHERE id = ?').get('e1');
    expect(row?.['id']).toBe('e1');
    expect(row?.['idempotency_key']).toBeNull();
    closeFleetDb(db);
  });

  it('lets many escalations share a null key while unique keys collide', () => {
    // A partial index: rows without a key are ordinary rows.
    const db = fresh();
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'M', '', 'active', 'watching', 60, 4, '/repo', 1, 1)`,
    ).run();
    const insert = (id: string, key: string | null) =>
      db
        .prepare(
          `INSERT INTO escalations (id, mission_id, source, request, reason, severity, resolution, created_at, idempotency_key)
           VALUES (?, 'm1', 'manager', 'r', 'x', 'warning', 'pending', 1, ?)`,
        )
        .run(id, key);

    insert('a', null);
    insert('b', null);
    insert('c', 'k');
    expect(() => insert('d', 'k')).toThrow();
    closeFleetDb(db);
  });
});
