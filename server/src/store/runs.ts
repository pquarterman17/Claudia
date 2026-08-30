import {
  canTransitionRun,
  canTransitionWorktree,
  RUN_TRANSITIONS,
  type AgentKind,
  type ChildRun,
  type ChildRunState,
  type WorktreeRecord,
  type WorktreeState,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { boolToInt, flag, int, optInt, optText, text, type Row } from './rows.js';

/**
 * Child runs and the worktrees they work in.
 *
 * A run is never mutated into a retry: attempts are separate rows, numbered per
 * task, so the history of a task that failed twice is still readable after it
 * succeeds. The unique (task_id, attempt) index is what makes a repeated
 * dispatch collide instead of quietly producing a second live child.
 */

export type NewChildRun = Omit<ChildRun, 'id' | 'attempt' | 'state' | 'startedAt' | 'endedAt' | 'terminalReason'> & {
  id?: string;
  /** Defaults to one past the highest attempt this task has already had. */
  attempt?: number;
  state?: ChildRunState;
  startedAt?: number;
};

export type NewWorktree = Omit<WorktreeRecord, 'id' | 'state' | 'dirty' | 'lastSeenAt' | 'createdAt'> & {
  id?: string;
  state?: WorktreeState;
  dirty?: boolean;
};

const RUN_COLUMNS =
  'id, mission_id, task_id, session_id, worktree_id, agent, attempt, state, started_at, ended_at, terminal_reason';
const WORKTREE_COLUMNS =
  'id, repo, path, branch, base_sha, owner_mission_id, owner_task_id, state, dirty, last_seen_at, created_at';

export class ChildRunRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewChildRun): StoreResult<ChildRun> {
    return transact(this.db, 'record the child run', () => {
      const run: ChildRun = {
        id: input.id ?? randomUUID(),
        missionId: input.missionId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        worktreeId: input.worktreeId,
        agent: input.agent,
        attempt: input.attempt ?? this.nextAttempt(input.taskId),
        state: input.state ?? 'dispatched',
        startedAt: input.startedAt ?? Date.now(),
      };
      this.db
        .prepare(`INSERT INTO child_runs (${RUN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          run.id,
          run.missionId,
          run.taskId,
          run.sessionId ?? null,
          run.worktreeId ?? null,
          run.agent,
          run.attempt,
          run.state,
          run.startedAt,
          null,
          null,
        );
      return run;
    });
  }

  get(id: string): StoreResult<ChildRun | undefined> {
    return attempt('read the child run', () => {
      const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE id = ?`).get(id) as Row | undefined;
      return row ? toRun(row) : undefined;
    });
  }

  /** Oldest attempt first, so a task's history reads top to bottom. */
  listByTask(taskId: string): StoreResult<ChildRun[]> {
    return attempt('list the task runs', () => {
      const rows = this.db
        .prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE task_id = ? ORDER BY attempt`)
        .all(taskId) as Row[];
      return rows.map(toRun);
    });
  }

  listByMission(missionId: string): StoreResult<ChildRun[]> {
    return attempt('list the mission runs', () => {
      const rows = this.db
        .prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE mission_id = ? ORDER BY started_at`)
        .all(missionId) as Row[];
      return rows.map(toRun);
    });
  }

  /**
   * Moves a run, refusing what RUN_TRANSITIONS does not allow.
   *
   * `endedAt` is stamped when the target state has no outgoing transitions,
   * which is the contract's own definition of terminal rather than a second
   * list of end states kept here, and it keeps the first end time rather than
   * being pushed forward by a later write. Re-applying the current state is a
   * no-op for the same replay reason as tasks, unless it carries a reason the
   * run did not have before.
   */
  setState(
    id: string,
    to: ChildRunState,
    detail: { terminalReason?: string; endedAt?: number } = {},
  ): StoreResult<ChildRun> {
    return transact(this.db, 'move the child run', () => {
      const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE id = ?`).get(id) as Row | undefined;
      if (!row) refuse(`No child run with id ${id}.`);
      const current = toRun(row);
      if (current.state === to && detail.terminalReason === undefined) return current;
      if (current.state !== to && !canTransitionRun(current.state, to)) {
        refuse(`A run that is ${current.state} cannot become ${to}.`);
      }
      const terminal = RUN_TRANSITIONS[to].length === 0;
      const endedAt = detail.endedAt ?? current.endedAt ?? (terminal ? Date.now() : undefined);
      const reason = detail.terminalReason ?? current.terminalReason;
      this.db
        .prepare('UPDATE child_runs SET state = ?, ended_at = ?, terminal_reason = ? WHERE id = ?')
        .run(to, endedAt ?? null, reason ?? null, id);
      return { ...current, state: to, endedAt, terminalReason: reason };
    });
  }

  private nextAttempt(taskId: string): number {
    const row = this.db.prepare('SELECT MAX(attempt) AS highest FROM child_runs WHERE task_id = ?').get(taskId) as
      | Row
      | undefined;
    const highest = row?.['highest'];
    return (typeof highest === 'number' || typeof highest === 'bigint' ? Number(highest) : 0) + 1;
  }
}

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
        .prepare(`INSERT INTO worktrees (${WORKTREE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
        .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE path = ? AND state <> 'removed'`)
        .get(path) as Row | undefined;
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

function toRun(row: Row): ChildRun {
  return {
    id: text(row, 'id'),
    missionId: text(row, 'mission_id'),
    taskId: text(row, 'task_id'),
    sessionId: optText(row, 'session_id'),
    worktreeId: optText(row, 'worktree_id'),
    agent: text(row, 'agent') as AgentKind,
    attempt: int(row, 'attempt'),
    state: text(row, 'state') as ChildRunState,
    startedAt: int(row, 'started_at'),
    endedAt: optInt(row, 'ended_at'),
    terminalReason: optText(row, 'terminal_reason'),
  };
}

function toWorktree(row: Row): WorktreeRecord {
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
