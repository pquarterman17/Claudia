// Must be imported before node:sqlite: the filter has to be installed before
// the module that emits the warning is loaded. Do not reorder.
import './experimental-warning.js';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations, type Migration } from './migrations.js';

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
 * and the built-in needs no build step at all.
 *
 * The floor is 22.16, not the 22.13 that node:sqlite alone needs. Found in
 * review: `transact` reads `DatabaseSync.isTransaction`, which landed in
 * 22.16.0, and on 22.13-22.15 an absent property is simply `undefined` — so a
 * repository call inside a raw BEGIN would issue a second BEGIN, and `onCommit`
 * would publish from inside a transaction it could not see finish. Both are
 * silent, and CI's matrix tests only the LATEST 22, so nothing here would have
 * caught it. `openFleetDb` refuses outright rather than running degraded.
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
 * Work that must not happen until the outermost transaction has committed.
 *
 * Keyed weakly for the same reason as `depth`: a closed database should not be
 * held alive by a queue nobody will drain.
 */
const afterCommit = new WeakMap<DatabaseSync, (() => void)[]>();

/**
 * Whether the transaction currently open is one THIS module opened.
 *
 * The distinction is not bookkeeping. A transaction opened through `transact`
 * has an outcome this module observes, so work can be deferred to its commit.
 * A transaction opened through the exposed connection does not: `BEGIN` and
 * `ROLLBACK` happen where nothing here can see them.
 */
const ownsTransaction = new WeakMap<DatabaseSync, true>();

/** Whether anything is open on this connection — including a BEGIN this module
 * did not issue, which `depth` alone cannot see. */
function inTransaction(db: DatabaseSync): boolean {
  if ((depth.get(db) ?? 0) > 0) return true;
  try {
    return db.isTransaction;
  } catch {
    // A closed connection throws on the getter. Caught by a test asserting the
    // store reports a dead connection as a VALUE: this is reached before
    // `attempt` wraps anything, so letting it escape would break the failure
    // contract the whole directory rests on. Nothing is open on a closed
    // database, and the operation that follows fails with a proper message.
    return false;
  }
}

/**
 * Whether a transaction is open that this module did not start.
 *
 * The one state in which deferred work has no observable outcome, so callers
 * whose correctness depends on being able to announce something can refuse
 * up front rather than write and stay quiet.
 */
export function foreignTransaction(db: DatabaseSync): boolean {
  return inTransaction(db) && ownsTransaction.get(db) !== true;
}

/**
 * Defers `fn` until the work around it is durable.
 *
 * The reason this exists is narrow and worth stating. `fleet_events.seq` is
 * AUTOINCREMENT so that a browser holding "I have seen up to N" can never
 * later be shown a different event at N or below. But sqlite_sequence is an
 * ordinary table and its bump rolls back with everything else, so a seq handed
 * out inside a transaction that then fails is RELEASED and given to the next
 * event. Measured, not reasoned about: appending inside a `transact` that
 * threw handed out seq 1 for a `dispatch`, and the next append — a
 * `task_failed` — was also given seq 1. Same number, different event, which is
 * exactly the invariant the AUTOINCREMENT was chosen to protect.
 *
 * A seq is only dangerous once somebody has been TOLD about it, so this is
 * where telling them waits. Callers still get the value back immediately for
 * their own bookkeeping; what they must not do is publish it, and this is the
 * thing that publishes.
 *
 * Fails safe in every direction. With nothing open the callback runs now,
 * because the work is already durable. Inside a transaction this module owns,
 * it waits for that commit. Inside one it does not own, it is dropped, because
 * the outcome is unobservable — see below. A dropped broadcast is a resync
 * away; a false one hands a client a number the log will reuse.
 */
export function onCommit(db: DatabaseSync, fn: () => void): void {
  if (!inTransaction(db)) {
    run(fn);
    return;
  }
  // Inside a transaction this module did not open, the callback is DROPPED.
  //
  // Found reviewing this module's own fix: queueing it instead was worse than
  // doing nothing. A raw BEGIN, an append, a raw ROLLBACK, and then any later
  // commit drained the queue -- so a subscriber was told about seq 1 for an
  // event that had been rolled back, and then about seq 1 again for the real
  // event that took the number. Two different events at one sequence, which is
  // the exact thing the deferral was written to prevent, reintroduced through
  // the one path that cannot see its own outcome.
  //
  // A dropped notification is a resync away. A false one is not.
  if (ownsTransaction.get(db) !== true) return;
  const queue = afterCommit.get(db) ?? [];
  afterCommit.set(db, queue);
  queue.push(fn);
}

/** A listener that throws must not take down the write it was listening to. */
function run(fn: () => void): void {
  try {
    fn();
  } catch {
    /* a subscriber's problem, not the store's */
  }
}

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
    // `depth` counts this module's own nesting; `isTransaction` also catches a
    // BEGIN issued through the exposed connection. Without that second check a
    // repository method called after a raw BEGIN issued a second BEGIN and
    // failed with "cannot start a transaction within a transaction" — the
    // documented escape hatch and the documented reentrancy could not be used
    // together.
    const nested = level > 0 || db.isTransaction;
    const savepoint = `claudia_sp_${level}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    depth.set(db, level + 1);
    if (!nested) ownsTransaction.set(db, true);
    // Where this savepoint found the queue, so its rollback discards exactly
    // what was registered inside it and leaves the outer transaction's alone.
    const mark = afterCommit.get(db)?.length ?? 0;
    try {
      const value = fn();
      db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      if (!nested) {
        ownsTransaction.delete(db);
        // Depth first. Found in review: draining while it still read 1 meant a
        // listener that appended an event was inside a "nested" transaction
        // that no longer existed — the row was written and committed, and its
        // own notification was then dropped because ownership had already been
        // cleared. Announced ["1:first"] while the log held ["first",
        // "by-listener"]. Resetting first makes a listener's append an
        // ordinary top-level one that publishes on its own commit.
        depth.set(db, level);
        drainAfterCommit(db);
      }
      return value;
    } catch (err) {
      // A rollback that itself fails means the connection is gone; the original
      // failure is the one worth reporting, so swallow this one.
      try {
        db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      } catch {
        /* connection already closed — nothing left to undo */
      }
      afterCommit.get(db)?.splice(mark);
      if (!nested) {
        ownsTransaction.delete(db);
        afterCommit.delete(db);
      }
      throw err;
    } finally {
      depth.set(db, level);
    }
  });
}

/**
 * Runs what was waiting, once, after the commit that made it true.
 *
 * Taken and cleared before anything runs, so a listener that appends another
 * event queues for the NEXT commit rather than joining the batch being drained
 * and never terminating.
 */
function drainAfterCommit(db: DatabaseSync): void {
  const queue = afterCommit.get(db);
  if (queue === undefined) return;
  afterCommit.delete(db);
  for (const fn of queue) run(fn);
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
export function openFleetDb(
  path: string = fleetDbPath(),
  /** Overridable so a test can open a database at an OLDER schema and then
   * upgrade it — the only way to exercise a migration against the real list
   * rather than a synthetic one appended to it. */
  migrations?: readonly Migration[],
): StoreResult<DatabaseSync> {
  return attempt('open the fleet database', () => {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    if (typeof db.isTransaction !== 'boolean') {
      db.close();
      refuse(
        `This build needs Node 22.16 or newer for its transaction handling; ${process.version} does not report ` +
          'DatabaseSync.isTransaction. Update Node, or run without the mission layer.',
      );
    }
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
      applyMigrations(db, migrations);
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
