import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isCapability, type Grant } from '../fleet/capabilities.js';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { optInt, text, type Row } from './rows.js';

/**
 * Where capability grants live, and the only way to obtain one.
 *
 * `capabilities.ts` says a grant "is only ever reached by LOOKING IT UP for a
 * run — never by being handed one", because provenance that travels with the
 * thing being checked is a suggestion rather than provenance. That argument
 * needs somewhere to look it up in, and until this table there was none: no
 * issuer, no store, and so nothing that ever called `checkCapability`.
 *
 * One row per run, keyed on the run. A second grant for the same run is the
 * standing permission the per-run scope exists to prevent, so the schema
 * refuses it rather than this code remembering to.
 */

const COLUMNS = 'run_id, id, mission_id, task_id, repo, worktree_path, capabilities, issued_by, expires_at, created_at';

export class GrantRepo {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Records a grant, and answers with the row that now exists.
   *
   * Issuing the same run's grant twice is not an error worth failing a launch
   * over — a retry of the write, a recovery pass — so the existing row is
   * returned. It is NOT overwritten: the grant that has been in force is the
   * one anything already checked against, and replacing it silently would let
   * a later call widen what an earlier decision was made on.
   */
  issue(grant: Grant): StoreResult<Grant> {
    return transact(this.db, 'issue the grant', () => {
      const held = this.db.prepare(`SELECT ${COLUMNS} FROM grants WHERE run_id = ?`).get(grant.runId) as Row | undefined;
      if (held) return toGrant(held);
      const createdAt = Date.now();
      this.db
        .prepare(`INSERT INTO grants (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          grant.runId,
          grant.id || randomUUID(),
          grant.missionId,
          grant.taskId,
          grant.scope.repo,
          grant.scope.worktreePath,
          JSON.stringify(grant.capabilities),
          grant.issuedBy,
          grant.expiresAt ?? null,
          createdAt,
        );
      const written = this.db.prepare(`SELECT ${COLUMNS} FROM grants WHERE run_id = ?`).get(grant.runId) as Row | undefined;
      if (!written) refuse('the grant vanished between writing and reading it');
      return toGrant(written);
    });
  }

  /**
   * The grant for a run, or nothing.
   *
   * Nothing is the safe answer and the common one — every run that predates
   * the table has none — and `checkCapability` refuses on it: "nothing has
   * been granted to this run" is the correct thing to say about a run nobody
   * bounded.
   */
  find(runId: string): StoreResult<Grant | undefined> {
    return attempt('read the grant', () => {
      const row = this.db.prepare(`SELECT ${COLUMNS} FROM grants WHERE run_id = ?`).get(runId) as Row | undefined;
      return row ? toGrant(row) : undefined;
    });
  }
}

/**
 * The stored row as a grant.
 *
 * The capability list is filtered through `isCapability` rather than cast.
 * Text in a column is not a union member, and a value that stopped being a
 * capability between releases would otherwise be compared against `needed` as
 * though it were one — which for the elevated set is the difference between a
 * refusal and a push.
 */
function toGrant(row: Row): Grant {
  const expiresAt = optInt(row, 'expires_at');
  return {
    id: text(row, 'id'),
    runId: text(row, 'run_id'),
    missionId: text(row, 'mission_id'),
    taskId: text(row, 'task_id'),
    scope: { repo: text(row, 'repo'), worktreePath: text(row, 'worktree_path') },
    capabilities: parseCapabilities(text(row, 'capabilities')),
    issuedBy: text(row, 'issued_by') as Grant['issuedBy'],
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

/** Malformed JSON grants nothing, which is the only safe reading of it. */
function parseCapabilities(raw: string): Grant['capabilities'] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCapability) : [];
  } catch {
    return [];
  }
}
