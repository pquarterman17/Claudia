import type { DatabaseSync } from 'node:sqlite';
import { ESCALATION_KEYS, FLEET_CORE } from './schema.js';
import { DURABLE_ESCALATIONS, refuseUnknownAgents, SCHEMA_BOUNDS } from './schema-constraints.js';

/**
 * Schema history, as an ordered list, and the runner that applies it.
 *
 * The rules that make this survivable:
 *
 * - A shipped migration is frozen. Editing one would leave every database that
 *   already ran it in a state no version number describes. New work is always a
 *   new entry appended to MIGRATIONS, with its SQL in its own schema file.
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
  /**
   * Set when `up` drops and recreates a table that other tables reference.
   *
   * SQLite cannot add or remove a constraint in place, so changing one means
   * the twelve-step rebuild: create, copy, drop, rename. With foreign keys
   * enforced, the `DROP` half of that fires every `ON DELETE CASCADE` pointing
   * at the table — dropping `missions` to widen a CHECK would take every task,
   * run and escalation in the file with it, silently and in one statement.
   * Measured, not assumed: with keys on, the child rows were gone.
   *
   * So the runner turns enforcement off around these, and pays for it with a
   * `foreign_key_check` inside the same transaction. The pragma is a no-op
   * inside a transaction, which is why this is a property of the migration the
   * runner reads rather than something `up` could do for itself.
   */
  rebuildsTables?: boolean;
  up(db: DatabaseSync): void;
}

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
  {
    version: 3,
    name: 'schema-bounds',
    rebuildsTables: true,
    up: (db) => {
      refuseUnknownAgents(db);
      db.exec(SCHEMA_BOUNDS);
    },
  },
  {
    version: 4,
    name: 'durable-escalations',
    rebuildsTables: true,
    up: (db) => db.exec(DURABLE_ESCALATIONS),
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
    // Outside the transaction, because `PRAGMA foreign_keys` is silently
    // ignored inside one — measured, not assumed: setting it within a BEGIN
    // left it at its previous value with no error. A rebuild that ran with
    // enforcement still on would cascade the table's children away.
    const enforcing = migration.rebuildsTables === true ? foreignKeysOn(db) : undefined;
    if (enforcing === true) db.exec('PRAGMA foreign_keys = OFF');
    try {
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
        // Enforcement was off for a rebuild, so nothing checked the references
        // the copy carried forward. This is the check, inside the same
        // transaction that did the work: a rebuild that lost a parent row or
        // mistyped a column rolls back rather than committing a file whose
        // foreign keys silently no longer hold.
        if (migration.rebuildsTables === true) assertReferencesHold(db, migration);
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
    } finally {
      // Restored even when the migration threw. Leaking `foreign_keys = OFF`
      // onto a live connection would disable enforcement for every write the
      // process makes afterwards — a far larger hole than the one the rebuild
      // was opened to close.
      if (enforcing === true) db.exec('PRAGMA foreign_keys = ON');
    }
    applied++;
  }
  return applied;
}

/** Whether this connection is enforcing foreign keys right now. */
function foreignKeysOn(db: DatabaseSync): boolean {
  const row = db.prepare('PRAGMA foreign_keys').get();
  return row?.['foreign_keys'] === 1;
}

/**
 * Fails the migration if the rebuild left a reference pointing at nothing.
 *
 * `PRAGMA foreign_key_check` reports every violation in the file rather than
 * stopping at the first, so the message can say which table and how many —
 * enough to tell a botched copy from a pre-existing orphan.
 */
function assertReferencesHold(db: DatabaseSync, migration: Migration): void {
  const violations = db.prepare('PRAGMA foreign_key_check').all() as { table?: unknown }[];
  if (violations.length === 0) return;
  const tables = [...new Set(violations.map((row) => String(row.table ?? 'unknown')))].sort();
  throw new Error(
    `rebuilding left ${violations.length} row(s) referencing a row that is not there, in: ${tables.join(', ')}. ` +
      `The file is unchanged; ${migration.name} did not commit.`,
  );
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

