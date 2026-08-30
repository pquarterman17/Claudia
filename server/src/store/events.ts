import type { FleetActor, FleetEvent } from '@claudia/shared';
import type { DatabaseSync } from 'node:sqlite';
import { attempt, refuse, transact, type StoreResult } from './db.js';
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
const MAX_PAGE = 5000;

const COLUMNS = 'seq, mission_id, task_id, run_id, actor, kind, payload, at, idempotency_key';

export class FleetEventLog {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Appends one event, or returns the existing one with the same key.
   *
   * The lookup and the insert share a transaction so two callers racing on the
   * same key cannot both decide it is new. The UNIQUE index is still what
   * guarantees it — this only keeps the common path from having to fail first.
   */
  append(input: NewFleetEvent): StoreResult<AppendedEvent> {
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
      return { event: toEvent(row), created: true };
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

  /** The high-water mark a client resyncs from. 0 when the log is empty. */
  latestSeq(): StoreResult<number> {
    return attempt('read the latest fleet sequence', () => {
      const row = this.db.prepare('SELECT MAX(seq) AS seq FROM fleet_events').get() as Row | undefined;
      const value = row?.['seq'];
      return typeof value === 'number' || typeof value === 'bigint' ? Number(value) : 0;
    });
  }
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
