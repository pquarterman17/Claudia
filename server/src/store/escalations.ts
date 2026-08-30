import type { Escalation, EscalationResolution, EscalationSeverity, FleetActor } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { int, optInt, optText, text, type Row } from './rows.js';

/**
 * Requests that need a decision before the fleet can go on.
 *
 * A `child` source is untrusted input by the plan's trust rules — nothing here
 * grants anything, it only records that permission was asked for. The grant is
 * a separate, human or policy decision that lands as a resolution.
 */

export type NewEscalation = Omit<
  Escalation,
  'id' | 'createdAt' | 'resolution' | 'resolvedAt' | 'resolutionNote' | 'severity'
> & {
  id?: string;
  severity?: EscalationSeverity;
};

const COLUMNS =
  'id, mission_id, task_id, run_id, source, request, reason, severity, resolution, expires_at, created_at, resolved_at, resolution_note, idempotency_key';

export class EscalationRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewEscalation): StoreResult<Escalation> {
    return attempt('raise the escalation', () => {
      // The same stuck run produces the same escalation on every pulse. Return
      // what is already there rather than filling the inbox a human is meant
      // to be reading — and enforce it here, at the write, because a key
      // checked anywhere above this is only advice.
      if (input.idempotencyKey !== undefined) {
        const existing = this.db
          .prepare(`SELECT ${COLUMNS} FROM escalations WHERE idempotency_key = ?`)
          .get(input.idempotencyKey);
        if (existing) return toEscalation(existing as Row);
      }
      const escalation: Escalation = {
        id: input.id ?? randomUUID(),
        missionId: input.missionId,
        taskId: input.taskId,
        runId: input.runId,
        source: input.source,
        request: input.request,
        reason: input.reason,
        severity: input.severity ?? 'warning',
        resolution: 'pending',
        expiresAt: input.expiresAt,
        createdAt: Date.now(),
        ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      };
      this.db
        .prepare(`INSERT INTO escalations (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          escalation.id,
          escalation.missionId,
          escalation.taskId ?? null,
          escalation.runId ?? null,
          escalation.source,
          escalation.request,
          escalation.reason,
          escalation.severity,
          escalation.resolution,
          escalation.expiresAt ?? null,
          escalation.createdAt,
          null,
          null,
          escalation.idempotencyKey ?? null,
        );
      return escalation;
    });
  }

  get(id: string): StoreResult<Escalation | undefined> {
    return attempt('read the escalation', () => {
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM escalations WHERE id = ?`).get(id) as Row | undefined;
      return row ? toEscalation(row) : undefined;
    });
  }

  /** Oldest first: an escalation inbox is a queue, not a feed. */
  listByMission(missionId: string, resolution?: EscalationResolution): StoreResult<Escalation[]> {
    return attempt('list the mission escalations', () => {
      const rows = (
        resolution
          ? this.db
              .prepare(`SELECT ${COLUMNS} FROM escalations WHERE mission_id = ? AND resolution = ? ORDER BY created_at`)
              .all(missionId, resolution)
          : this.db
              .prepare(`SELECT ${COLUMNS} FROM escalations WHERE mission_id = ? ORDER BY created_at`)
              .all(missionId)
      ) as Row[];
      return rows.map(toEscalation);
    });
  }

  /**
   * Settles a pending escalation.
   *
   * One way only, and only from pending. The contract has no transition table
   * for resolutions, so this is a store rule rather than a domain one, and a
   * narrow one: re-resolving a settled escalation would overwrite the record of
   * a decision someone made, which is the one thing an audit trail cannot do.
   */
  resolve(id: string, resolution: EscalationResolution, note?: string): StoreResult<Escalation> {
    return transact(this.db, 'resolve the escalation', () => {
      if (resolution === 'pending') refuse('An escalation cannot be resolved back to pending.');
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM escalations WHERE id = ?`).get(id) as Row | undefined;
      if (!row) refuse(`No escalation with id ${id}.`);
      const current = toEscalation(row);
      if (current.resolution !== 'pending') {
        refuse(`That escalation was already ${current.resolution}.`);
      }
      const resolvedAt = Date.now();
      this.db
        .prepare('UPDATE escalations SET resolution = ?, resolved_at = ?, resolution_note = ? WHERE id = ?')
        .run(resolution, resolvedAt, note ?? null, id);
      return { ...current, resolution, resolvedAt, resolutionNote: note };
    });
  }
}

function toEscalation(row: Row): Escalation {
  return {
    id: text(row, 'id'),
    missionId: text(row, 'mission_id'),
    taskId: optText(row, 'task_id'),
    runId: optText(row, 'run_id'),
    source: text(row, 'source') as FleetActor,
    request: text(row, 'request'),
    reason: text(row, 'reason'),
    severity: text(row, 'severity') as EscalationSeverity,
    resolution: text(row, 'resolution') as EscalationResolution,
    expiresAt: optInt(row, 'expires_at'),
    createdAt: int(row, 'created_at'),
    resolvedAt: optInt(row, 'resolved_at'),
    resolutionNote: optText(row, 'resolution_note'),
    idempotencyKey: optText(row, 'idempotency_key'),
  };
}
