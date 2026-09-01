import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AGENT_KINDS, MAX_CHILDREN_CEILING, PULSE_MAX_SEC, PULSE_MIN_SEC } from '@claudia/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { closeFleetDb, openFleetDb } from '../src/store/db.js';
import { openFleetStore } from '../src/store/index.js';
import { isSqliteExperimentalWarning } from '../src/store/experimental-warning.js';
import { applyMigrations, latestVersion, MIGRATIONS, schemaVersion, type Migration } from '../src/store/migrations.js';

const dir = mkdtempSync(join(tmpdir(), 'claudia-store-mig-'));

/** Closed before the directory goes. An open handle makes unlink fail with
 * EBUSY on Windows, failing the whole file in teardown while every test
 * reports as passing — invisible on Linux, which unlinks open files. */
const opened: DatabaseSync[] = [];
/** Same teardown, for handles opened by the damaged-file cases below. */
const kept: DatabaseSync[] = [];
afterAll(() => {
  for (const db of [...opened, ...kept]) closeFleetDb(db);
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

describe('upgrading a database that already holds data', () => {
  it('carries a real version-1 file all the way forward, rows and all', () => {
    // The gate that matters for every migration after the first: a file with
    // data in it reaches the newest schema without losing any of it. Versions
    // 3 and 4 rebuild three tables between them, so "the row is still there"
    // is no longer the given it was when every migration only added a column.
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
      `INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
       VALUES ('t1', 'm1', 'T', '', '/repo', 'running', 0, '[]', '', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO child_runs (id, mission_id, task_id, agent, attempt, state, started_at)
       VALUES ('r1', 'm1', 't1', 'codex', 1, 'running', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO escalations (id, mission_id, source, request, reason, severity, resolution, created_at)
       VALUES ('e1', 'm1', 'human', 'push', 'because', 'warning', 'pending', 1)`,
    ).run();

    // Derived, not hardcoded: a count written by hand here is a line every
    // future migration has to remember to bump, and forgetting reads as a bug
    // in the runner rather than a stale test.
    const pending = MIGRATIONS.filter((m) => m.version > 1).length;
    expect(applyMigrations(db)).toBe(pending);
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));

    // The version-2 column, on the row that predates it.
    const escalation = db.prepare('SELECT id, mission_id, idempotency_key FROM escalations WHERE id = ?').get('e1');
    expect(escalation?.['id']).toBe('e1');
    expect(escalation?.['idempotency_key']).toBeNull();
    expect(escalation?.['mission_id']).toBe('m1');

    // And everything the rebuilds in 3 and 4 dropped and recreated.
    expect(db.prepare('SELECT name FROM missions WHERE id = ?').get('m1')?.['name']).toBe('Old');
    expect(db.prepare('SELECT title FROM tasks WHERE id = ?').get('t1')?.['title']).toBe('T');
    const run = db.prepare('SELECT agent, attempt, state FROM child_runs WHERE id = ?').get('r1');
    expect(run).toMatchObject({ agent: 'codex', attempt: 1, state: 'running' });
    closeFleetDb(db);
  });

  it('restores foreign key enforcement after a rebuild, and after one that fails', () => {
    // The leak that would matter most: `PRAGMA foreign_keys = OFF` left on a
    // live connection disables enforcement for every write the process makes
    // afterwards, which is a much larger hole than the rebuild was opened to
    // close.
    const db = fresh();
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);

    const doomed: Migration[] = [
      ...MIGRATIONS,
      {
        version: latestVersion(MIGRATIONS) + 1,
        name: 'doomed-rebuild',
        rebuildsTables: true,
        up: (target) => target.exec('CREATE TABLE nope (id TEXT); DROP TABLE definitely_not_there;'),
      },
    ];
    expect(() => applyMigrations(db, doomed)).toThrow(/doomed-rebuild/);
    expect(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys']).toBe(1);
  });

  it('refuses to commit a rebuild that leaves a reference pointing at nothing', () => {
    const db = fresh();
    const broken: Migration[] = [
      ...MIGRATIONS,
      {
        version: latestVersion(MIGRATIONS) + 1,
        name: 'orphan-maker',
        rebuildsTables: true,
        // With enforcement off, this insert is accepted; the check inside the
        // transaction is the only thing standing between it and a committed
        // file whose foreign keys no longer hold.
        up: (target) =>
          target.exec(
            `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
               VALUES ('mx', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1);
             INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
               VALUES ('tx', 'no-such-mission', 'T', '', '/repo', 'proposed', 0, '[]', '', 1, 1);`,
          ),
      },
    ];
    expect(() => applyMigrations(db, broken)).toThrow(/referencing a row that is not there.*tasks/s);
    // Rolled back whole: neither row landed, and the version did not move.
    expect(db.prepare('SELECT COUNT(*) AS n FROM missions').get()?.['n']).toBe(0);
    expect(schemaVersion(db)).toBe(latestVersion(MIGRATIONS));
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

describe('the schema refuses what the fleet has no meaning for', () => {
  /**
   * Every case here was reproduced against the shipped schema before the
   * migration was written: each one was ACCEPTED and read back as a typed
   * value the fleet would then act on.
   */
  it('refuses a pulse of zero and a child limit of nine thousand', () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();
    // A pulse of zero is a reconciler in a tight loop, and every iteration of
    // that loop spends money.
    expect(() => db.prepare('UPDATE missions SET pulse_sec = 0 WHERE id = ?').run('m1')).toThrow(/CHECK/);
    expect(() => db.prepare('UPDATE missions SET max_children = 9999 WHERE id = ?').run('m1')).toThrow(/CHECK/);
    // And the bounds are bounds, not a zero check.
    expect(() => db.prepare('UPDATE missions SET pulse_sec = 29 WHERE id = ?').run('m1')).toThrow(/CHECK/);
    expect(() => db.prepare('UPDATE missions SET max_children = 13 WHERE id = ?').run('m1')).toThrow(/CHECK/);
    db.prepare('UPDATE missions SET pulse_sec = 30, max_children = 12 WHERE id = ?').run('m1');
    expect(db.prepare('SELECT pulse_sec, max_children FROM missions WHERE id = ?').get('m1')).toMatchObject({
      pulse_sec: 30,
      max_children: 12,
    });
  });

  it('refuses an agent that is not a harness Claudia can run', () => {
    const db = fresh();
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
       VALUES ('t1', 'm1', 'T', '', '/repo', 'proposed', 0, '[]', '', 1, 1)`,
    ).run();
    let attempt = 0;
    const insert = (agent: string) =>
      db
        .prepare(
          `INSERT INTO child_runs (id, mission_id, task_id, agent, attempt, state, started_at)
           VALUES (?, 'm1', 't1', ?, ?, 'running', 1)`,
        )
        // A distinct attempt each time, so the unique (task_id, attempt) index
        // cannot be what refuses a row and be mistaken for the CHECK.
        .run(`r-${agent}`, agent, ++attempt);
    expect(() => insert('gemini')).toThrow(/CHECK/);
    // Both members of the roster still go in, so this is a roster and not a ban.
    for (const agent of AGENT_KINDS) expect(() => insert(agent)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM child_runs').get()?.['n']).toBe(AGENT_KINDS.length);
  });

  it('keeps the frozen bounds in step with the contract they came from', () => {
    // A shipped migration cannot be edited, so the literals in it are frozen
    // while the constants they mirror are not. Without this, raising
    // MAX_CHILDREN_CEILING would leave the schema silently one release behind
    // and the failure would surface as a rejected write nobody could explain.
    // Read off the real migrated schema rather than the migration source, so a
    // migration that fails to apply cannot pass this.
    const db = fresh();
    const missions = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'missions'").get()?.['sql']);
    expect(missions, 'add a migration when the pulse bounds change').toContain(
      `pulse_sec BETWEEN ${PULSE_MIN_SEC} AND ${PULSE_MAX_SEC}`,
    );
    expect(missions, 'add a migration when the child ceiling changes').toContain(
      `max_children BETWEEN 1 AND ${MAX_CHILDREN_CEILING}`,
    );
    const runs = String(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'child_runs'").get()?.['sql']);
    const roster = AGENT_KINDS.map((kind) => `'${kind}'`).join(',');
    expect(runs, 'add a migration when the agent roster changes').toContain(`agent IN (${roster})`);
  });

  it('clamps a nonsense pulse forward rather than making the file unopenable', () => {
    // The upgrade hazard: a value written before the constraint existed cannot
    // satisfy it. Refusing would leave that database permanently unopenable
    // with no repair path, which is worse than moving a value the fleet
    // already refuses to create into the range it already enforces.
    const path = join(dir, 'clamp', 'fleet.db');
    const before = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 2));
    if (!before.ok) throw new Error(before.message);
    opened.push(before.value);
    before.value
      .prepare(
        `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
         VALUES ('m1', 'M', '', 'active', 'paused', 0, 9999, '/repo', 1, 1),
                ('m2', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
      )
      .run();
    expect(applyMigrations(before.value)).toBe(MIGRATIONS.filter((m) => m.version > 2).length);
    expect(before.value.prepare('SELECT pulse_sec, max_children FROM missions WHERE id = ?').get('m1')).toMatchObject({
      pulse_sec: PULSE_MIN_SEC,
      max_children: MAX_CHILDREN_CEILING,
    });
    // A mission the repository could legitimately have written is untouched.
    expect(before.value.prepare('SELECT pulse_sec, max_children FROM missions WHERE id = ?').get('m2')).toMatchObject({
      pulse_sec: 60,
      max_children: 4,
    });
  });

  it('names the rows when an agent cannot be carried forward', () => {
    // Nothing to clamp an unknown harness to, and inventing one would misreport
    // which agent did the work. So this failure is deliberate — and it has to
    // say enough to be answerable, which "CHECK constraint failed" does not.
    const path = join(dir, 'bad-agent', 'fleet.db');
    const before = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 2));
    if (!before.ok) throw new Error(before.message);
    opened.push(before.value);
    before.value
      .prepare(
        `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
         VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
      )
      .run();
    before.value
      .prepare(
        `INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
         VALUES ('t1', 'm1', 'T', '', '/repo', 'proposed', 0, '[]', '', 1, 1)`,
      )
      .run();
    before.value
      .prepare(
        `INSERT INTO child_runs (id, mission_id, task_id, agent, attempt, state, started_at)
         VALUES ('r-odd', 'm1', 't1', 'gemini', 1, 'running', 1)`,
      )
      .run();

    expect(() => applyMigrations(before.value)).toThrow(/r-odd \(agent "gemini"\)/);
    // Refused whole: the file stays where it was, and the data is still there.
    expect(schemaVersion(before.value)).toBe(2);
    expect(before.value.prepare('SELECT COUNT(*) AS n FROM child_runs').get()?.['n']).toBe(1);
  });
});

describe('an escalation outlives what it was about', () => {
  it('keeps a resolved approval after its mission is deleted', () => {
    // Measured against the shipped schema before this migration: an escalation
    // resolved "approved", with the note a person wrote, came back undefined
    // after one DELETE FROM missions. A record of who agreed to what is the one
    // thing a cascade must not be able to reach.
    const db = fresh();
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
       VALUES ('t1', 'm1', 'T', '', '/repo', 'proposed', 0, '[]', '', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO child_runs (id, mission_id, task_id, agent, attempt, state, started_at)
       VALUES ('r1', 'm1', 't1', 'claude', 1, 'running', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO escalations (id, mission_id, task_id, run_id, source, request, reason, severity, resolution, created_at, resolved_at, resolution_note)
       VALUES ('e1', 'm1', 't1', 'r1', 'child', 'git.push', 'wants to push', 'blocking', 'approved', 1, 2, 'approved at the console')`,
    ).run();

    db.prepare('DELETE FROM missions WHERE id = ?').run('m1');

    const kept = db.prepare('SELECT * FROM escalations WHERE id = ?').get('e1');
    expect(kept).toMatchObject({
      resolution: 'approved',
      resolution_note: 'approved at the console',
      // And which run it was for. ON DELETE SET NULL was the same loss more
      // quietly: an approval left standing with nothing saying what it was for.
      run_id: 'r1',
      task_id: 't1',
      mission_id: 'm1',
    });
    // The operational rows are gone, which is the line: state belongs to the
    // thing that owns it, the record of what happened does not.
    expect(db.prepare('SELECT COUNT(*) AS n FROM child_runs').get()?.['n']).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n']).toBe(0);
  });
});

describe('a file that arrives damaged still opens', () => {
  /** Opens at v2, orphans a row with foreign keys OFF the way an external tool
   * would, and hands back the path to reopen at the latest version. */
  function orphanedAt(name: string, orphan: (db: DatabaseSync) => void): string {
    const path = join(dir, name, 'fleet.db');
    const at2 = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 2));
    if (!at2.ok) throw new Error(at2.message);
    at2.value.exec(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
         VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1);
       INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
         VALUES ('t1', 'm1', 'T', '', '/repo', 'proposed', 0, '[]', '', 1, 1);`,
    );
    // Both the sqlite3 CLI and Python's driver default this OFF, which is how
    // an orphan gets into a file nothing in Claudia would have produced.
    at2.value.exec('PRAGMA foreign_keys = OFF');
    orphan(at2.value);
    closeFleetDb(at2.value);
    return path;
  }

  it('migrates past an orphan it did not create, in a table it never touches', () => {
    // Found by audit. `PRAGMA foreign_key_check` scans the WHOLE database, and
    // version 3 is the first migration to run it — so every pre-existing orphan
    // anywhere in the file became a permanent refusal to open, taking the entire
    // mission layer down and blaming a rebuild that had done nothing wrong.
    const path = orphanedAt('orphan-task', (db) => db.exec("DELETE FROM missions WHERE id = 'm1'"));
    const opened = openFleetDb(path);
    expect(opened.ok, opened.ok ? '' : opened.message).toBe(true);
    if (!opened.ok) return;
    kept.push(opened.value);
    expect(schemaVersion(opened.value)).toBe(latestVersion(MIGRATIONS));
    // The damage is carried forward, not silently repaired — that is the user's
    // call, and the rows are still there to make it with.
    expect(opened.value.prepare('SELECT COUNT(*) AS n FROM tasks').get()?.['n']).toBe(1);
  });

  it('is not blocked by the very thing migration 4 exists to allow', () => {
    // The sharpest case: an escalation whose mission was deleted externally
    // blocked version 3 — while version 4, the next entry, exists precisely so
    // that an escalation CAN outlive its mission.
    const path = orphanedAt('orphan-escalation', (db) => {
      db.exec(
        `INSERT INTO escalations (id, mission_id, source, request, reason, severity, resolution, created_at, resolved_at, resolution_note)
           VALUES ('e1', 'm1', 'human', 'git.push', 'x', 'blocking', 'approved', 1, 2, 'approved at the console');
         DELETE FROM missions WHERE id = 'm1';`,
      );
    });
    const opened = openFleetDb(path);
    expect(opened.ok, opened.ok ? '' : opened.message).toBe(true);
    if (!opened.ok) return;
    kept.push(opened.value);
    expect(opened.value.prepare('SELECT resolution_note FROM escalations WHERE id = ?').get('e1')).toMatchObject({
      resolution_note: 'approved at the console',
    });
  });

  it('still refuses a rebuild that breaks a reference itself', () => {
    // The gate is now a difference, not a total — so it must still catch damage
    // the migration causes, on a file that already had some.
    const path = orphanedAt('orphan-and-broken', (db) => db.exec("DELETE FROM missions WHERE id = 'm1'"));
    const at2 = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 2));
    if (!at2.ok) throw new Error(at2.message);
    kept.push(at2.value);
    const breaking: Migration[] = [
      ...MIGRATIONS.filter((m) => m.version <= 2),
      {
        version: 3,
        name: 'breaks-more',
        rebuildsTables: true,
        up: (db) =>
          db.exec(
            `INSERT INTO tasks (id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at)
               VALUES ('t2', 'also-missing', 'T', '', '/repo', 'proposed', 0, '[]', '', 1, 1)`,
          ),
      },
    ];
    expect(() => applyMigrations(at2.value, breaking)).toThrow(/referencing a row that is not there.*tasks/s);
    expect(schemaVersion(at2.value)).toBe(2);
  });

  it('names the migration even when the write lock is held by somebody else', () => {
    // BEGIN IMMEDIATE sat outside the try that names the migration, so the one
    // failure a user is most likely to hit came back as a bare
    // "database is locked" with nothing saying a migration was involved.
    const path = join(dir, 'locked', 'fleet.db');
    const holder = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 2));
    if (!holder.ok) throw new Error(holder.message);
    kept.push(holder.value);
    const other = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 2));
    if (!other.ok) throw new Error(other.message);
    kept.push(other.value);

    holder.value.exec('BEGIN IMMEDIATE');
    holder.value.exec('PRAGMA busy_timeout = 0');
    other.value.exec('PRAGMA busy_timeout = 0');
    try {
      expect(() => applyMigrations(other.value)).toThrow(/Migration 3 \(schema-bounds\) failed/);
    } finally {
      holder.value.exec('ROLLBACK');
    }
  });
});

describe('one live claim per directory, not per spelling', () => {
  it('refuses a second live row for the same Windows checkout', () => {
    // Measured before this migration: samePath folded case and separators while
    // the unique index compared raw text, so `C:\Repo\Work` and `c:/repo/work`
    // were one directory to the policy that decides who may write there and two
    // rows to the index that makes ownership provable. Two live claims, two
    // owners, one checkout on disk.
    const db = fresh();
    db.prepare(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
       VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1)`,
    ).run();
    const insert = (id: string, key: string) =>
      db
        .prepare(
          `INSERT INTO worktrees (id, repo, path, path_key, branch, base_sha, owner_mission_id, state, dirty, last_seen_at, created_at)
           VALUES (?, 'C:\\Repo', ?, ?, 'b', 'a', 'm1', 'active', 0, 1, 1)`,
        )
        .run(id, id, key);
    insert('w1', 'c:/repo/work');
    expect(() => insert('w2', 'c:/repo/work')).toThrow(/UNIQUE/);
    // A removed row frees it again, as before.
    db.prepare("UPDATE worktrees SET state = 'removed' WHERE id = 'w1'").run();
    expect(() => insert('w3', 'c:/repo/work')).not.toThrow();
  });

  it('settles duplicates the old index allowed, keeping the newest', () => {
    // Rows that collapse onto one key are the old bug's output, not two real
    // claims. Refusing would make a file unopenable over damage this schema
    // itself permitted — the hazard the clamping decision was taken to avoid.
    const path = join(dir, 'dup-paths', 'fleet.db');
    const before = openFleetDb(path, MIGRATIONS.filter((m) => m.version <= 4));
    if (!before.ok) throw new Error(before.message);
    kept.push(before.value);
    before.value.exec(
      `INSERT INTO missions (id, name, body, status, watch, pulse_sec, max_children, cwd, created_at, updated_at)
         VALUES ('m1', 'M', '', 'active', 'paused', 60, 4, '/repo', 1, 1);
       INSERT INTO worktrees (id, repo, path, branch, base_sha, owner_mission_id, state, dirty, last_seen_at, created_at)
         VALUES ('old', '/repo', '/wt/Work', 'b', 'a', 'm1', 'active', 0, 1, 1),
                ('new', '/repo', '/wt/Work/', 'b', 'a', 'm1', 'active', 0, 1, 2);`,
    );
    expect(applyMigrations(before.value)).toBe(1);
    const live = before.value
      .prepare("SELECT id FROM worktrees WHERE state <> 'removed'")
      .all()
      .map((r) => String(r['id']));
    expect(live).toEqual(['new']);
    // The older claim is retired rather than deleted: it is still history.
    expect(before.value.prepare('SELECT COUNT(*) AS n FROM worktrees').get()?.['n']).toBe(2);
  });

  it('keeps the path the caller wrote, and canonicalises only the key', () => {
    const fleet = openFleetStore(join(dir, 'keeps-path', 'fleet.db'));
    if (!fleet.ok) throw new Error(fleet.message);
    kept.push(fleet.value.db);
    const mission = fleet.value.missions.create({ name: 'm', body: '', cwd: '/repo' });
    if (!mission.ok) throw new Error(mission.message);
    const made = fleet.value.worktrees.create({
      repo: '/repo',
      path: '/wt/Mixed/Case/',
      branch: 'b',
      baseSha: 'a',
      ownerMissionId: mission.value.id,
      dirty: false,
    });
    expect(made.ok, made.ok ? '' : made.message).toBe(true);
    if (!made.ok) return;
    // What a human reads, and what gets handed to `cd`, is untouched.
    expect(made.value.path).toBe('/wt/Mixed/Case/');
    // And the trailing slash no longer makes it a different directory.
    const found = fleet.value.worktrees.byPath('/wt/Mixed/Case');
    expect(found.ok && found.value?.id).toBe(made.value.id);
  });
});
