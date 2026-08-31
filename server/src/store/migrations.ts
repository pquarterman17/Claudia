import type { DatabaseSync } from 'node:sqlite';

/**
 * Schema history, as an ordered list.
 *
 * The rules that make this survivable:
 *
 * - A shipped migration is frozen. Editing one would leave every database that
 *   already ran it in a state no version number describes. New work is always a
 *   new entry appended to MIGRATIONS.
 * - `user_version` (a four-byte field in the SQLite header, transactional like
 *   any other write) records how far a file has come. No side table to keep in
 *   step with the schema it is describing.
 * - Each migration runs in its own transaction together with its version bump,
 *   so a failure half way through leaves the file at the last version that
 *   fully applied rather than at some blend of two.
 */
export interface Migration {
  /** Strictly ascending, never reused, never edited once released. */
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * The durable entities of plans/ARGUS_PARITY_PLAN.md, one table each, mirroring
 * the shapes in shared/src/mission.ts.
 *
 * STRICT tables: SQLite otherwise stores whatever it is handed, so a bug that
 * writes a number into `status` would round-trip silently and only surface as a
 * status nothing in the UI can render. STRICT makes that a write error.
 *
 * The CHECK constraints repeat the status unions from the domain contract. That
 * duplication is deliberate: the repositories validate, but the file also
 * outlives this process and may be opened by a future version or a human with a
 * sqlite3 prompt, and the database should refuse a state the fleet has no
 * meaning for regardless of who is writing.
 */
const FLEET_CORE = `
CREATE TABLE missions (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  status        TEXT    NOT NULL CHECK (status IN ('active','completed','archived')),
  watch         TEXT    NOT NULL CHECK (watch IN ('watching','paused')),
  pulse_sec     INTEGER NOT NULL,
  max_children  INTEGER NOT NULL,
  -- Null means no ceiling. Both are enforced by the dispatcher; the store only
  -- has to make them survive a restart, since a budget forgotten on restart is
  -- a budget that never applied.
  budget_sec    INTEGER CHECK (budget_sec IS NULL OR budget_sec > 0),
  budget_tokens INTEGER CHECK (budget_tokens IS NULL OR budget_tokens > 0),
  cwd           TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE tasks (
  id           TEXT    PRIMARY KEY,
  mission_id   TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  description  TEXT    NOT NULL,
  cwd          TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN
                 ('proposed','ready','blocked','running','reported','accepted','failed','cancelled')),
  priority     INTEGER NOT NULL,
  -- A JSON array of task ids. Dependencies are read whole, per task, and never
  -- joined on; a link table would buy nothing and cost a second write path.
  depends_on   TEXT    NOT NULL,
  acceptance   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX tasks_by_mission ON tasks (mission_id, priority, created_at);

CREATE TABLE worktrees (
  id                TEXT    PRIMARY KEY,
  repo              TEXT    NOT NULL,
  path              TEXT    NOT NULL,
  branch            TEXT    NOT NULL,
  base_sha          TEXT    NOT NULL,
  owner_mission_id  TEXT    REFERENCES missions(id) ON DELETE SET NULL,
  owner_task_id     TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  state             TEXT    NOT NULL CHECK (state IN ('active','idle','stale','archived','removed')),
  dirty             INTEGER NOT NULL CHECK (dirty IN (0,1)),
  last_seen_at      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
) STRICT;

-- One live record per directory: two rows claiming the same path would make
-- ownership unprovable, which is exactly what the plan forbids. Removed rows are
-- history and are exempt, so a path can legitimately be claimed again later.
CREATE UNIQUE INDEX worktrees_live_path ON worktrees (path) WHERE state <> 'removed';

CREATE TABLE child_runs (
  id               TEXT    PRIMARY KEY,
  mission_id       TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id          TEXT    NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  -- Null once the live session has gone; the run record outlives the process.
  session_id       TEXT,
  worktree_id      TEXT    REFERENCES worktrees(id) ON DELETE SET NULL,
  agent            TEXT    NOT NULL,
  attempt          INTEGER NOT NULL CHECK (attempt >= 1),
  state            TEXT    NOT NULL CHECK (state IN
                     ('dispatched','running','reported','stopped','failed')),
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  terminal_reason  TEXT
) STRICT;

-- A retry is a new attempt number, so this is the last line of defence against a
-- repeated pulse dispatching the same attempt twice.
CREATE UNIQUE INDEX child_runs_attempt ON child_runs (task_id, attempt);
CREATE INDEX child_runs_by_mission ON child_runs (mission_id, started_at);

CREATE TABLE escalations (
  id               TEXT    PRIMARY KEY,
  mission_id       TEXT    NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  task_id          TEXT    REFERENCES tasks(id) ON DELETE SET NULL,
  run_id           TEXT    REFERENCES child_runs(id) ON DELETE SET NULL,
  source           TEXT    NOT NULL CHECK (source IN ('human','manager','child','system')),
  request          TEXT    NOT NULL,
  reason           TEXT    NOT NULL,
  severity         TEXT    NOT NULL CHECK (severity IN ('info','warning','blocking')),
  resolution       TEXT    NOT NULL CHECK (resolution IN
                     ('pending','approved','denied','expired','withdrawn')),
  -- Null means the request stands until someone answers it. Without a time to
  -- compare against, the 'expired' resolution is unreachable.
  expires_at       INTEGER,
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  resolution_note  TEXT
) STRICT;

CREATE INDEX escalations_by_mission ON escalations (mission_id, resolution, created_at);

CREATE TABLE fleet_events (
  -- AUTOINCREMENT, not a plain rowid: plain rowids are reused after the highest
  -- row is deleted, and a browser holding "I have seen up to seq N" must never
  -- be shown a different event numbered N or below.
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Deliberately NOT a foreign key. The log is the audit trail and has to
  -- survive the mission it describes; a cascade here would erase the history of
  -- exactly the deletion someone later wants to explain.
  mission_id       TEXT    NOT NULL,
  -- Denormalised for filtering, and unconstrained for the same reason as
  -- mission_id: an event outlives the task or run it is about.
  task_id          TEXT,
  run_id           TEXT,
  actor            TEXT    NOT NULL CHECK (actor IN ('human','manager','child','system')),
  kind             TEXT    NOT NULL,
  -- JSON text. Read back with JSON.parse and never evaluated.
  payload          TEXT    NOT NULL,
  at               INTEGER NOT NULL,
  -- Optional, but unique when present: this is what makes a repeated pulse a
  -- no-op instead of a second dispatch. SQLite treats NULLs as distinct, so
  -- unkeyed events are unaffected by the constraint.
  idempotency_key  TEXT    UNIQUE
) STRICT;

CREATE INDEX fleet_events_by_mission ON fleet_events (mission_id, seq);
-- Partial, because most events belong to a mission rather than to one task, and
-- an index over all those nulls would cost every append without serving a read.
-- Run-level filtering rides on this one: a run's events are a subset of its
-- task's, and a second index on the append path is not worth that narrowing.
CREATE INDEX fleet_events_by_task ON fleet_events (task_id, seq) WHERE task_id IS NOT NULL;
`;

/**
 * Escalations get an idempotency key, enforced by the database.
 *
 * A watchdog tick that finds a stuck run produces the same escalation every
 * time, and a key returned by a pure helper stops nothing on its own — the
 * repository was generating a fresh UUID per call, so a pulse each minute
 * filed a new inbox row each minute. The uniqueness has to live where the
 * write happens; anything above it is advisory.
 *
 * Added as its own migration rather than amended into `fleet-core`: the point
 * of a version list is that a later change cannot disturb what already ran.
 */
const ESCALATION_KEYS = `
ALTER TABLE escalations ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX escalations_key ON escalations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'fleet-core',
    up: (db) => db.exec(FLEET_CORE),
  },
  {
    version: 2,
    name: 'escalation-idempotency',
    up: (db) => db.exec(ESCALATION_KEYS),
  },
];

export function latestVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

/** How far this file has been migrated. 0 for a database that has never run one. */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get();
  const value = row?.['user_version'];
  return typeof value === 'number' ? value : 0;
}

/**
 * Brings `db` up to the latest version and returns how many migrations ran.
 *
 * Throws rather than returning a result: the only caller is openFleetDb, which
 * turns it into a value. Tests call it directly, where a throw is what they
 * want to assert on.
 */
export function applyMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  assertOrdered(migrations);
  const current = schemaVersion(db);
  const latest = latestVersion(migrations);
  if (current > latest) {
    // Downgrading is not a thing we can do correctly, and running today's code
    // against tomorrow's schema is how a file gets quietly corrupted.
    throw new Error(
      `fleet.db is at schema version ${current}, newer than this build understands (${latest}). ` +
        'Update Claudia, or move the file aside to start fresh.',
    );
  }

  let applied = 0;
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read INSIDE the write lock. The version above was sampled before
      // anything was serialised, so two processes opening the same file — the
      // old sidecar still holding it while a new one starts, which is the
      // restart this store exists for — both saw the old version, and the
      // loser replayed a migration that had already run. It failed with
      // "duplicate column name", openFleetStore returned a failure, and the
      // mission layer went silently unavailable on a perfectly healthy,
      // fully-migrated database.
      if (schemaVersion(db) >= migration.version) {
        db.exec('ROLLBACK');
        continue;
      }
      migration.up(db);
      // PRAGMA takes no bound parameters, so the version is interpolated. It is
      // an integer checked by assertOrdered, never anything user-supplied.
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* connection gone; the original failure is the one that matters */
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${migration.version} (${migration.name}) failed: ${detail}`);
    }
    applied++;
  }
  return applied;
}

/**
 * Guards the invariant the whole scheme rests on. Two branches each appending
 * "version 2" is the realistic way this list goes wrong, and it is much cheaper
 * to catch here than in a half-migrated file on a user's machine.
 */
function assertOrdered(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error(
        `Migrations must have ascending integer versions; ${migration.name} has ${migration.version} after ${previous}.`,
      );
    }
    previous = migration.version;
  }
}
