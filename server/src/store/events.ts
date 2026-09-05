import type { FleetActor, FleetEvent } from '@claudia/shared';
import type { DatabaseSync } from 'node:sqlite';
import { attempt, fail, foreignTransaction, onCommit, refuse, transact, type StoreResult } from './db.js';
import { int, optText, text, type Row } from './rows.js';

/**
 * The append-only fleet log.
 *
 * Two properties do the real work here. `seq` is monotonic across the whole
 * log, which is what lets a browser that fell behind say "I have seen up to N"
 * and be caught up exactly, without diffing state. And `idempotencyKey` makes a
 * repeated pulse harmless: the reconciler can append the same decision twice
 * and the second append returns the first event rather than duplicating it.
 *
 * Nothing here updates or deletes. A correction is a later event.
 */

export interface NewFleetEvent {
  missionId: string;
  /** Set when the event is about one task or one run, so the timeline can
   * filter on it instead of parsing `payload`. */
  taskId?: string;
  runId?: string;
  actor: FleetActor;
  kind: string;
  /** Anything JSON-serialisable; stored as text and never evaluated. */
  payload: unknown;
  /** Defaults to now. Injectable so tests and replays can be deterministic. */
  at?: number;
  /** Optional, but unique across the log when present. */
  idempotencyKey?: string;
}

export interface AppendedEvent {
  event: FleetEvent;
  /** False when an event with this idempotency key was already there. */
  created: boolean;
}

/** A page big enough for a normal resync, small enough not to stall a socket. */
export const DEFAULT_PAGE = 500;

/**
 * The largest batch this log will ever return, and therefore the largest
 * window a resync may plan for. Exported so `maxBatch` can be chosen against
 * the number the store actually honours rather than guessed.
 */
export const MAX_PAGE = 5000;

const COLUMNS = 'seq, mission_id, task_id, run_id, actor, kind, payload, at, idempotency_key';

export class FleetEventLog {
  constructor(private readonly db: DatabaseSync) {}

  private readonly listeners = new Set<(event: FleetEvent) => void>();

  /**
   * Subscribes to events that have actually landed. Returns an unsubscribe.
   *
   * This is the ONLY safe way to forward an event to a client, and the reason
   * is `seq`. `append` returns the number immediately because a caller needs it
   * for its own bookkeeping, but inside a transaction that number is not yet
   * real: sqlite_sequence rolls back with everything else, so a failed step
   * releases the seq and the next event is given the same one. Reproduced
   * before this was written -- seq 1 went out for a `dispatch`, the step threw,
   * and seq 1 came back for a `task_failed`. A browser told the first number
   * would never be shown the second event, which is the exact hole
   * AUTOINCREMENT was chosen to close.
   *
   * Listeners here fire from the after-commit queue, so they cannot observe a
   * sequence the log might still reuse.
   */
  onAppended(listener: (event: FleetEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Appends one event, or returns the existing one with the same key.
   *
   * The lookup and the insert share a transaction so two callers racing on the
   * same key cannot both decide it is new. The UNIQUE index is still what
   * guarantees it — this only keeps the common path from having to fail first.
   */
  append(input: NewFleetEvent): StoreResult<AppendedEvent> {
    // Refused, not silently unannounced. `onCommit` cannot observe a
    // transaction this module did not open, so it drops the notification — and
    // a dropped notification is only harmless if something else repairs it. A
    // connected client does NOT resync merely because one event went missing,
    // so it would sit there with a gap it has no reason to look for. Raised in
    // review, and the answer is the one the store already has: `transact` is
    // the composition API, and it drains on its own commit.
    // Returned, not thrown: this guard sits BEFORE `transact`, so nothing here
    // would wrap it, and the whole directory's contract is that no store method
    // throws at a caller reached from a websocket handler. Caught by the test
    // that asserts a dead connection comes back as a value.
    if (foreignTransaction(this.db)) {
      return fail('An event cannot be appended inside a transaction the store did not open; use transact().');
    }
    return transact(this.db, 'append a fleet event', () => {
      const key = input.idempotencyKey;
      if (key !== undefined) {
        const existing = this.db
          .prepare(`SELECT ${COLUMNS} FROM fleet_events WHERE idempotency_key = ?`)
          .get(key) as Row | undefined;
        if (existing) return { event: toEvent(existing), created: false };
      }
      const row = this.db
        .prepare(
          `INSERT INTO fleet_events (mission_id, task_id, run_id, actor, kind, payload, at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
        )
        .get(
          input.missionId,
          input.taskId ?? null,
          input.runId ?? null,
          input.actor,
          input.kind,
          serialise(input.payload),
          input.at ?? Date.now(),
          key ?? null,
        ) as Row | undefined;
      if (!row) refuse('The fleet event was not written.');
      const event = toEvent(row);
      // Deferred, not called: see onAppended. Nothing fires for the idempotent
      // path above, because nothing was appended.
      onCommit(this.db, () => {
        // Guarded per listener, not around the loop. Found by the test below:
        // one wrapper around the whole fan-out meant the first subscriber to
        // throw swallowed the event for every subscriber after it.
        for (const listener of this.listeners) {
          try {
            listener(event);
          } catch {
            /* a subscriber's problem, not the log's */
          }
        }
      });
      return { event, created: true };
    });
  }

  /** Everything after `afterSeq`, oldest first: the browser resync read. */
  since(afterSeq: number, limit: number = DEFAULT_PAGE): StoreResult<FleetEvent[]> {
    return attempt('read the fleet log', () => {
      const rows = this.db
        .prepare(`SELECT ${COLUMNS} FROM fleet_events WHERE seq > ? ORDER BY seq LIMIT ?`)
        .all(afterSeq, page(limit)) as Row[];
      return rows.map(toEvent);
    });
  }

  /** The same read, narrowed to one mission. */
  sinceForMission(missionId: string, afterSeq = 0, limit: number = DEFAULT_PAGE): StoreResult<FleetEvent[]> {
    return attempt('read a mission log', () => {
      const rows = this.db
        .prepare(`SELECT ${COLUMNS} FROM fleet_events WHERE mission_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
        .all(missionId, afterSeq, page(limit)) as Row[];
      return rows.map(toEvent);
    });
  }

  /**
   * One task's history: its dispatches, state changes and reports.
   *
   * The narrowing a run needs goes through here too — a run's events are a
   * subset of its task's, and filtering that small result in the caller costs
   * less than a second index on every append.
   */
  sinceForTask(taskId: string, afterSeq = 0, limit: number = DEFAULT_PAGE): StoreResult<FleetEvent[]> {
    return attempt('read a task log', () => {
      const rows = this.db
        .prepare(`SELECT ${COLUMNS} FROM fleet_events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
        .all(taskId, afterSeq, page(limit)) as Row[];
      return rows.map(toEvent);
    });
  }

  /**
   * Exactly the window a resync planned, or a failure saying why not.
   *
   * Found by audit: `planResync` produced `{fromSeq: 1, toSeq: 1200,
   * more: false}` and the caller read it with `sinceForMission(id, 0)`, whose
   * limit defaults to 500. The store returned 500 events, `replayIsUsable`
   * on a filtered stream accepted them, and the client was told it was caught
   * up to 1200 having been sent a third of it — a 700-event hole, which is the
   * exact silent gap the whole resync design exists to prevent.
   *
   * The bug was not the clamp, it was that the limit and the window were two
   * numbers a caller had to keep equal by hand. This takes the window and
   * derives the limit, so they cannot disagree; a window bigger than the log
   * will ever return is refused rather than quietly served short.
   */
  replay(window: { fromSeq: number; toSeq: number; missionId?: string; taskId?: string }): StoreResult<FleetEvent[]> {
    return attempt('replay a window of the fleet log', () => {
      const { fromSeq, toSeq, missionId, taskId } = window;
      if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(toSeq) || toSeq < fromSeq) {
        refuse('That is not a window the log can be read for.');
      }
      const size = toSeq - fromSeq + 1;
      if (size > MAX_PAGE) {
        refuse(`A replay window of ${size} is larger than the ${MAX_PAGE} events this log will return at once.`);
      }
      const filters = ['seq >= ?', 'seq <= ?'];
      const values: (string | number)[] = [fromSeq, toSeq];
      if (missionId !== undefined) {
        filters.push('mission_id = ?');
        values.push(missionId);
      }
      if (taskId !== undefined) {
        filters.push('task_id = ?');
        values.push(taskId);
      }
      const rows = this.db
        .prepare(`SELECT ${COLUMNS} FROM fleet_events WHERE ${filters.join(' AND ')} ORDER BY seq LIMIT ?`)
        // The window is the limit. Asking for one more would be a way to
        // detect truncation; there is nothing to detect once they are equal.
        .all(...values, size) as Row[];
      return rows.map(toEvent);
    });
  }

  /**
   * The newest events for one mission, oldest-first, and how many precede them.
   *
   * Selected in the MISSION's own event space, not in sequence space, and that
   * distinction is the whole reason this exists rather than a `replay` window
   * ending at the newest sequence. A mission's sequences are sparse — every
   * event another mission wrote takes a number this one skips — so a window
   * 500 wide can hold five of this mission's events. A tail computed that way
   * silently drops the rest and reports nothing missing, which is a smaller
   * copy of the bug this whole change is about.
   *
   * `ORDER BY seq DESC LIMIT n` then reversed: the database picks the newest n
   * rows THIS mission has, whatever numbers they carry.
   */
  tailForMission(missionId: string, limit: number = DEFAULT_PAGE): StoreResult<{ events: FleetEvent[]; older: number }> {
    return attempt('read the end of a mission log', () => {
      const rows = this.db
        .prepare(`SELECT ${COLUMNS} FROM fleet_events WHERE mission_id = ? ORDER BY seq DESC LIMIT ?`)
        .all(missionId, page(limit)) as Row[];
      const events = rows.map(toEvent).reverse();
      const total = this.db
        .prepare('SELECT COUNT(*) AS n FROM fleet_events WHERE mission_id = ?')
        .get(missionId) as Row | undefined;
      return { events, older: Math.max(0, seqOf(total?.['n']) - events.length) };
    });
  }

  /**
   * The oldest and newest sequence ONE mission's log still holds.
   *
   * Per mission, not global, and that is the whole point of it existing.
   * `planResync` compares the client's cursor against these bounds, and
   * `resync.ts` says so in as many words: bounds must be "that stream's own
   * oldest and newest, not the whole log's, or pruning inside the window goes
   * unnoticed". A mission's sequences are sparse — every event another mission
   * wrote occupies a number this one skips — so the global high-water mark
   * would put a client's cursor beyond a log that has nothing after it.
   *
   * `{ oldestSeq: 0, newestSeq: 0 }` for a mission with no events, which
   * `planResync` reads as up-to-date for a client that also has nothing.
   */
  boundsForMission(missionId: string): StoreResult<{ oldestSeq: number; newestSeq: number }> {
    return attempt('read a mission log’s bounds', () => {
      const row = this.db
        .prepare('SELECT MIN(seq) AS oldest, MAX(seq) AS newest FROM fleet_events WHERE mission_id = ?')
        .get(missionId) as Row | undefined;
      return { oldestSeq: seqOf(row?.['oldest']), newestSeq: seqOf(row?.['newest']) };
    });
  }

  /** The high-water mark a client resyncs from. 0 when the log is empty. */
  latestSeq(): StoreResult<number> {
    return attempt('read the latest fleet sequence', () => {
      const row = this.db.prepare('SELECT MAX(seq) AS seq FROM fleet_events').get() as Row | undefined;
      const value = row?.['seq'];
      return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 0;
    });
  }
}

/** A sequence off an aggregate, or 0 when the aggregate had no rows to take. */
function seqOf(value: unknown): number {
  return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 0;
}

/**
 * Clamped rather than trusted: `limit` reaches here from a client asking to be
 * caught up, and an unbounded page would let one slow consumer pull the whole
 * history into memory in a single read.
 */
function page(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return DEFAULT_PAGE;
  return Math.min(Math.floor(limit), MAX_PAGE);
}

function serialise(payload: unknown): string {
  try {
    // `undefined` stringifies to undefined, which the NOT NULL column rejects
    // with a message about the column rather than about the payload.
    return JSON.stringify(payload ?? null) ?? 'null';
  } catch {
    refuse('The event payload could not be stored as JSON.');
  }
}

function toEvent(row: Row): FleetEvent {
  return {
    seq: int(row, 'seq'),
    missionId: text(row, 'mission_id'),
    taskId: optText(row, 'task_id'),
    runId: optText(row, 'run_id'),
    actor: text(row, 'actor') as FleetActor,
    kind: text(row, 'kind'),
    payload: parsePayload(text(row, 'payload')),
    at: int(row, 'at'),
    idempotencyKey: optText(row, 'idempotency_key'),
  };
}

/**
 * A payload that will not parse is returned as its raw text rather than
 * refused. The field is `unknown` by contract, and one corrupt row must not be
 * able to break the resync that would let a user see what went wrong.
 */
function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
