import {
  canTransitionRun,
  canTransitionWorktree,
  RUN_TRANSITIONS,
  type ChildRun,
  type ChildRunState,
  type WorktreeRecord,
  type WorktreeState,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { HOST_PLATFORM, worktreePathKey } from '../path-key.js';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { agentKind, boolToInt, flag, int, optInt, optText, text, type Row } from './rows.js';

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
const WORKTREE_INSERT = `${WORKTREE_COLUMNS}, path_key`;

/**
 * The runs in a batch that can be read, rather than none of them.
 *
 * `toRun` refuses a row whose agent is outside the roster, which is right for
 * `get` — that caller asked about that run. Found by audit: in a LIST it meant
 * `rows.map(toRun)` threw on the first bad entry and every good run in the same
 * mission became unreachable with it. Only a file written by an older build can
 * hold one, which is exactly the moment a user most needs to see the rest.
 *
 * `events.ts` already made this call for a corrupt payload and says why: one
 * bad row must not break the read that would let somebody see what went wrong.
 */
function readable(rows: readonly Row[]): ChildRun[] {
  const runs: ChildRun[] = [];
  for (const row of rows) {
    try {
      runs.push(toRun(row));
    } catch {
      /* unreadable, and named by get(id) for anyone who asks about it directly */
    }
  }
  return runs;
}

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
        agent: agentKind(input.agent),
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
      return readable(rows);
    });
  }

  listByMission(missionId: string): StoreResult<ChildRun[]> {
    return attempt('list the mission runs', () => {
      const rows = this.db
        .prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE mission_id = ? ORDER BY started_at`)
        .all(missionId) as Row[];
      return readable(rows);
    });
  }

  /**
   * Every run still occupying a slot, across all missions.
   *
   * Asked by things that need to know a session is the fleet's before deciding
   * something about it — the browser-idle reaper above all, which stops
   * sessions nobody is watching and would otherwise stop the fleet's own
   * children thirty seconds after the tab closes.
   */
  listActive(): StoreResult<ChildRun[]> {
    return attempt('list the active runs', () => {
      const rows = this.db
        .prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE state IN ('dispatched','running') ORDER BY started_at`)
        .all() as Row[];
      return readable(rows);
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

  /**
   * Records which session a reserved run actually got.
   *
   * The run row is written BEFORE the session exists — that is what makes it a
   * reservation, and what stops a repeated pulse paying for the same attempt
   * twice. So the id has to arrive afterwards, and until it does the watchdog
   * sees a run whose session is missing, which is its definition of an orphan.
   *
   * Write-once. A run is one attempt at one task by one session: a second id
   * would mean either the launcher started two children for one reservation or
   * a live run was quietly reassigned, and both are states the rest of the
   * fleet reasons by assuming cannot happen. Re-attaching the SAME id is a
   * no-op, so a retried launch that already succeeded is harmless.
   *
   * And REFUSED once the reservation has been retired. Found in review: the
   * starting grace can expire while startup is still in flight, so a later
   * pulse fails this run and reserves its replacement — and the slow launcher
   * then arrives with an id for a row nothing counts as active and the watchdog
   * never assesses. Answering `ok` there told the launcher it had succeeded
   * when it had lost its slot, so the child it started would never be stopped.
   * The refusal is how it finds out, and it has to be decided inside this
   * transaction because the retirement races it.
   */
  attachSession(id: string, sessionId: string): StoreResult<ChildRun> {
    return transact(this.db, 'attach a session to the child run', () => {
      const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE id = ?`).get(id) as Row | undefined;
      if (!row) refuse(`No child run with id ${id}.`);
      const current = toRun(row);
      if (current.sessionId === sessionId) return current;
      if (current.sessionId !== undefined) {
        refuse(`Child run ${id} already belongs to session ${current.sessionId}.`);
      }
      if (current.state !== 'dispatched' && current.state !== 'running') {
        refuse(`Child run ${id} is ${current.state} and is no longer waiting for a session.`);
      }
      if (!sessionId) refuse('A session id is required to attach one.');
      this.db.prepare('UPDATE child_runs SET session_id = ? WHERE id = ?').run(sessionId, id);
      return { ...current, sessionId };
    });
  }

  /**
   * Records which worktree a reserved run actually claimed.
   *
   * The other half of `attachSession`, and it was missing. The launcher made
   * the directory, wrote the worktree row and then threw the id away, so every
   * real child ran with `worktreeId` undefined — and `gatherEvidence` reads
   * exactly that field. The acceptance judgement therefore had nothing to look
   * at for any run the fleet ever started: every verdict came back
   * `needs_human` with every fact missing, and the only place the link existed
   * was a test fixture that built it by hand.
   *
   * Write-once and refused once the reservation is retired, for the same
   * reasons as the session id above: two worktrees for one attempt would mean
   * a run whose evidence is read from a directory it did not work in, and a
   * retired reservation is one the launcher has already lost.
   */
  attachWorktree(id: string, worktreeId: string): StoreResult<ChildRun> {
    return transact(this.db, 'attach a worktree to the child run', () => {
      const row = this.db.prepare(`SELECT ${RUN_COLUMNS} FROM child_runs WHERE id = ?`).get(id) as Row | undefined;
      if (!row) refuse(`No child run with id ${id}.`);
      const current = toRun(row);
      if (current.worktreeId === worktreeId) return current;
      if (current.worktreeId !== undefined) {
        refuse(`Child run ${id} already works in worktree ${current.worktreeId}.`);
      }
      if (current.state !== 'dispatched' && current.state !== 'running') {
        refuse(`Child run ${id} is ${current.state} and is no longer claiming a worktree.`);
      }
      if (!worktreeId) refuse('A worktree id is required to attach one.');
      this.db.prepare('UPDATE child_runs SET worktree_id = ? WHERE id = ?').run(worktreeId, id);
      return { ...current, worktreeId };
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

function toRun(row: Row): ChildRun {
  return {
    id: text(row, 'id'),
    missionId: text(row, 'mission_id'),
    taskId: text(row, 'task_id'),
    sessionId: optText(row, 'session_id'),
    worktreeId: optText(row, 'worktree_id'),
    agent: agentKind(text(row, 'agent')),
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
