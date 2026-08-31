// Must be imported before node:sqlite: the filter has to be installed before
// the module that emits the warning is loaded. Do not reorder.
import './experimental-warning.js';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from './migrations.js';

/**
 * The fleet database: one SQLite file beside settings.json.
 *
 * Preferences stay in that JSON — one flat record, hand-editable, no schema.
 * This is the other half the plan asks for: relational operational state
 * (missions, tasks, runs, worktrees, an append-only event log) that has to
 * outlive the process and be queried by parent, by status and by sequence.
 *
 * node:sqlite rather than better-sqlite3 because Claudia ships as a Tauri
 * sidecar: a native module would need rebuilding per platform and per Node ABI,
 * and the built-in needs no build step at all. It requires Node 22.13+, which
 * is why the root engines field moved.
 *
 * FAILURE CONTRACT: nothing in this directory throws at its callers. Every
 * public store method returns a StoreResult, because these are reached from
 * websocket command handlers where an unhandled throw takes down the process
 * and the whole board with it — the same reason worktree.ts reports failure as
 * a value. A store that cannot open leaves the caller holding
 * `{ ok: false, message }` and free to run memory-only; a store that breaks
 * mid-flight fails one command, with a message the UI can show, and the rest of
 * the server keeps running.
 */

/**
 * A failure worth showing a human: an illegal transition, a missing row, a
 * database that will not open. Anything else thrown inside the store is a bug
 * or a dead connection and gets wrapped with the operation's name instead.
 */
export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Refuses an operation with a message meant for a person, not a log. */
export function refuse(message: string): never {
  throw new StoreError(message);
}

export type StoreResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function ok<T>(value: T): StoreResult<T> {
  return { ok: true, value };
}

export function fail<T>(message: string): StoreResult<T> {
  return { ok: false, message };
}

/**
 * Runs `fn` and converts every possible outcome into a value.
 *
 * `what` names the operation in the wrapped message ("Could not append a fleet
 * event: ..."), so a failure that reaches the UI says which command died —
 * which a bare SQLite string never does.
 */
export function attempt<T>(what: string, fn: () => T): StoreResult<T> {
  try {
    return ok(fn());
  } catch (err) {
    if (err instanceof StoreError) return fail(err.message);
    const detail = err instanceof Error ? err.message : String(err);
    return fail(`Could not ${what}: ${detail}`);
  }
}

/**
 * Nesting depth per connection, so a transaction inside a transaction becomes a
 * savepoint instead of the error SQLite raises for a second BEGIN. Keyed weakly
 * so a closed database is not held alive by its counter.
 */
const depth = new WeakMap<DatabaseSync, number>();

/**
 * One SQLite transaction around `fn`, rolled back on any throw.
 *
 * IMMEDIATE rather than deferred: it takes the write lock up front, so a
 * read-then-write body (check the current status, then move it) cannot have
 * another connection slip a write in between and cannot fail late with a busy
 * error it can no longer retry cleanly.
 *
 * Reentrant, because repository methods that each need atomicity will be
 * composed by the reconciler into one larger atomic step. An inner call becomes
 * a savepoint: its failure undoes its own work and leaves the outer transaction
 * intact and still open, which is what a caller that means to carry on after a
 * refused step needs.
 */
export function transact<T>(db: DatabaseSync, what: string, fn: () => T): StoreResult<T> {
  return attempt(what, () => {
    const level = depth.get(db) ?? 0;
    const savepoint = `claudia_sp_${level}`;
    db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    depth.set(db, level + 1);
    try {
      const value = fn();
      db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return value;
    } catch (err) {
      // A rollback that itself fails means the connection is gone; the original
      // failure is the one worth reporting, so swallow this one.
      try {
        db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch {
        /* connection already closed — nothing left to undo */
      }
      throw err;
    } finally {
      depth.set(db, level);
    }
  });
}

/** Honours CLAUDIA_DATA_DIR the same way settingsPath() does, for the same reason. */
export function fleetDbPath(): string {
  return join(process.env['CLAUDIA_DATA_DIR'] ?? join(homedir(), '.claudia'), 'fleet.db');
}

/**
 * Opens the database, applies pending migrations, and hands back a connection.
 *
 * Injectable path so tests get a temp directory and never touch the real
 * ~/.claudia. ':memory:' works too, though a memory database defeats the point
 * of the thing being tested.
 */
export function openFleetDb(path: string = fleetDbPath()): StoreResult<DatabaseSync> {
  return attempt('open the fleet database', () => {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      // WAL so a long read (a browser resyncing a large event log) never blocks
      // the writer, and so a crash mid-write recovers from the log rather than
      // leaving a truncated page. NORMAL synchronous is WAL's safe pairing:
      // durable across a process crash, and only a machine-level power loss can
      // cost the last commits — acceptable for operational state that a running
      // fleet re-derives anyway.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      // A second connection (a future reader, or a stale one during restart)
      // should wait briefly rather than fail the command outright.
      db.exec('PRAGMA busy_timeout = 5000');
      applyMigrations(db);
      return db;
    } catch (err) {
      // A half-open connection is worse than none: close it before reporting,
      // so the file is not left locked by a database nobody holds a handle to.
      try {
        db.close();
      } catch {
        /* already closed */
      }
      throw err;
    }
  });
}

/** Closing is best-effort: a failure here cannot be acted on and must not throw. */
export function closeFleetDb(db: DatabaseSync): void {
  try {
    db.close();
  } catch {
    /* already closed, or never opened */
  }
}
