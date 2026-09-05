import { canTransitionWorktree, type WorktreeRecord, type WorktreeState } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HOST_PLATFORM, worktreePathKey } from '../path-key.js';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { boolToInt, flag, int, optText, text, type Row } from './rows.js';

/**
 * The directories the fleet has claimed, and the rows that prove the claim.
 *
 * Split out of `runs.ts` when the ownership check `attachWorktree` needed
 * pushed that file over the size ceiling. The two were together because a run
 * works in a worktree, but the shapes are independent — a worktree outlives
 * every attempt that used it — and the dependency now runs one way: a run
 * reads a worktree row to prove the link it is being asked to write, and
 * nothing here knows about runs.
 *
 * `path_key` is the ownership key rather than `path`: `worktrees_live_path` is
 * `UNIQUE (path_key) WHERE state <> 'removed'`, so one directory reached by two
 * spellings cannot take two live claims.
 */

export type NewWorktree = Omit<WorktreeRecord, 'id' | 'state' | 'dirty' | 'lastSeenAt' | 'createdAt'> & {
  id?: string;
  state?: WorktreeState;
  dirty?: boolean;
};

/**
 * Shared with `runs.ts`, which reads a worktree row inside its own transaction
 * to prove that the run being linked to it actually owns it.
 */
export const WORKTREE_COLUMNS =
  'id, repo, path, branch, base_sha, owner_mission_id, owner_task_id, state, dirty, last_seen_at, created_at';
const WORKTREE_INSERT = `${WORKTREE_COLUMNS}, path_key`;

export class WorktreeRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewWorktree): StoreResult<WorktreeRecord> {
    return attempt('record the worktree', () => {
      const now = Date.now();
      const record: WorktreeRecord = {
        id: input.id ?? randomUUID(),
        repo: input.repo,
        path: input.path,
        branch: input.branch,
        baseSha: input.baseSha,
        ownerMissionId: input.ownerMissionId,
        ownerTaskId: input.ownerTaskId,
        state: input.state ?? 'active',
        dirty: input.dirty ?? false,
        lastSeenAt: now,
        createdAt: now,
      };
      this.db
        .prepare(`INSERT INTO worktrees (${WORKTREE_INSERT}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          record.id,
          record.repo,
          record.path,
          record.branch,
          record.baseSha,
          record.ownerMissionId ?? null,
          record.ownerTaskId ?? null,
          record.state,
          boolToInt(record.dirty),
          record.lastSeenAt,
          record.createdAt,
          worktreePathKey(record.path, HOST_PLATFORM),
        );
      return record;
    });
  }

  get(id: string): StoreResult<WorktreeRecord | undefined> {
    return attempt('read the worktree record', () => {
      const row = this.db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE id = ?`).get(id) as Row | undefined;
      return row ? toWorktree(row) : undefined;
    });
  }

  /** The live claim on a directory, if the fleet holds one. */
  byPath(path: string): StoreResult<WorktreeRecord | undefined> {
    return attempt('read the worktree record', () => {
      const row = this.db
        .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE path_key = ? AND state <> 'removed'`)
        .get(worktreePathKey(path, HOST_PLATFORM)) as Row | undefined;
      return row ? toWorktree(row) : undefined;
    });
  }

  listByMission(missionId: string): StoreResult<WorktreeRecord[]> {
    return attempt('list the mission worktrees', () => {
      const rows = this.db
        .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE owner_mission_id = ? ORDER BY created_at`)
        .all(missionId) as Row[];
      return rows.map(toWorktree);
    });
  }

  setState(id: string, to: WorktreeState): StoreResult<WorktreeRecord> {
    return transact(this.db, 'move the worktree record', () => {
      const current = this.load(id);
      if (current.state === to) return current;
      if (!canTransitionWorktree(current.state, to)) {
        refuse(`A worktree that is ${current.state} cannot become ${to}.`);
      }
      const lastSeenAt = Date.now();
      this.db.prepare('UPDATE worktrees SET state = ?, last_seen_at = ? WHERE id = ?').run(to, lastSeenAt, id);
      return { ...current, state: to, lastSeenAt };
    });
  }

  /** What a reconciler writes after looking at the directory on disk. */
  markSeen(id: string, dirty: boolean, at: number = Date.now()): StoreResult<WorktreeRecord> {
    return transact(this.db, 'update the worktree record', () => {
      const current = this.load(id);
      this.db.prepare('UPDATE worktrees SET dirty = ?, last_seen_at = ? WHERE id = ?').run(boolToInt(dirty), at, id);
      return { ...current, dirty, lastSeenAt: at };
    });
  }

  private load(id: string): WorktreeRecord {
    const row = this.db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE id = ?`).get(id) as Row | undefined;
    if (!row) refuse(`No worktree record with id ${id}.`);
    return toWorktree(row);
  }
}

export function toWorktree(row: Row): WorktreeRecord {
  return {
    id: text(row, 'id'),
    repo: text(row, 'repo'),
    path: text(row, 'path'),
    branch: text(row, 'branch'),
    baseSha: text(row, 'base_sha'),
    ownerMissionId: optText(row, 'owner_mission_id'),
    ownerTaskId: optText(row, 'owner_task_id'),
    state: text(row, 'state') as WorktreeState,
    dirty: flag(row, 'dirty'),
    lastSeenAt: int(row, 'last_seen_at'),
    createdAt: int(row, 'created_at'),
  };
}
