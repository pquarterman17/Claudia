import {
  canTransitionMission,
  canTransitionTask,
  MAX_CHILDREN_CEILING,
  MAX_CHILDREN_DEFAULT,
  PULSE_DEFAULT_SEC,
  PULSE_MAX_SEC,
  PULSE_MIN_SEC,
  type Mission,
  type MissionStatus,
  type MissionWatch,
  type Task,
  type TaskStatus,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { idList, int, optInt, text, type Row } from './rows.js';

/**
 * Missions and their tasks.
 *
 * The repositories own two things the callers should not have to think about:
 * the row/domain translation, and the transition rules. Status moves go through
 * canTransitionTask from the domain contract rather than a second copy of the
 * table living here — the whole point of that table being data is that the
 * store, the reconciler and the UI cannot disagree about what "blocked" allows.
 */

export type NewMission = Omit<Mission, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'watch' | 'pulseSec' | 'maxChildren'> & {
  /** Supplied when the caller needs a known id (a replay, a fixture). */
  id?: string;
  status?: MissionStatus;
  watch?: MissionWatch;
  pulseSec?: number;
  maxChildren?: number;
};

/**
 * Dependencies checked on the way IN, not only on the way out.
 *
 * The column is plain TEXT and the reader refuses anything that is not a list
 * of strings — and that refusal propagates out of the whole `listByMission`
 * map, so one malformed row made an entire mission permanently unrenderable
 * with no repair path. `events.ts` already made the opposite call for the same
 * hazard, so that one corrupt row cannot break the read that would explain it.
 * Validating the write is what lets the strict read stay strict.
 */
function dependencies(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id === '')) {
    refuse('Task dependencies must be a list of task ids.');
  }
  return [...value];
}

export type NewTask = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'priority' | 'dependsOn' | 'acceptance'> & {
  id?: string;
  status?: TaskStatus;
  priority?: number;
  dependsOn?: string[];
  acceptance?: string;
};

const MISSION_COLUMNS =
  'id, name, body, status, watch, pulse_sec, max_children, budget_sec, budget_tokens, cwd, created_at, updated_at';
const TASK_COLUMNS =
  'id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at';

export class MissionRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewMission): StoreResult<Mission> {
    return attempt('create the mission', () => {
      const now = Date.now();
      const mission: Mission = {
        id: input.id ?? randomUUID(),
        name: input.name,
        body: input.body,
        status: input.status ?? 'active',
        watch: input.watch ?? 'paused',
        pulseSec: bounded('pulse', input.pulseSec ?? PULSE_DEFAULT_SEC, PULSE_MIN_SEC, PULSE_MAX_SEC),
        maxChildren: bounded('child limit', input.maxChildren ?? MAX_CHILDREN_DEFAULT, 1, MAX_CHILDREN_CEILING),
        budgetSec: ceiling('time budget', input.budgetSec),
        budgetTokens: ceiling('token budget', input.budgetTokens),
        cwd: input.cwd,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(`INSERT INTO missions (${MISSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          mission.id,
          mission.name,
          mission.body,
          mission.status,
          mission.watch,
          mission.pulseSec,
          mission.maxChildren,
          mission.budgetSec ?? null,
          mission.budgetTokens ?? null,
          mission.cwd,
          mission.createdAt,
          mission.updatedAt,
        );
      return mission;
    });
  }

  get(id: string): StoreResult<Mission | undefined> {
    return attempt('read the mission', () => {
      const row = this.db.prepare(`SELECT ${MISSION_COLUMNS} FROM missions WHERE id = ?`).get(id) as Row | undefined;
      return row ? toMission(row) : undefined;
    });
  }

  /** Newest first, which is the order the Mission Center lists them in. */
  list(status?: MissionStatus): StoreResult<Mission[]> {
    return attempt('list missions', () => {
      const rows = (
        status
          ? this.db
              .prepare(`SELECT ${MISSION_COLUMNS} FROM missions WHERE status = ? ORDER BY created_at DESC`)
              .all(status)
          : this.db.prepare(`SELECT ${MISSION_COLUMNS} FROM missions ORDER BY created_at DESC`).all()
      ) as Row[];
      return rows.map(toMission);
    });
  }

  /**
   * Moves a mission, refusing what MISSION_TRANSITIONS does not allow.
   *
   * Same shape as the task and run moves: read and write in one transaction, a
   * re-applied status is a no-op, and the table in the contract is the only
   * copy of the rules.
   */
  setStatus(id: string, status: MissionStatus): StoreResult<Mission> {
    return transact(this.db, 'move the mission', () => {
      const current = this.load(id);
      if (current.status === status) return current;
      if (!canTransitionMission(current.status, status)) {
        refuse(`A mission that is ${current.status} cannot become ${status}.`);
      }
      return { ...current, status, updatedAt: this.touch(id, 'status', status) };
    });
  }

  /**
   * Watching or paused is a posture, not a lifecycle: it can be flipped from
   * either side at any time, so there is nothing to validate.
   */
  setWatch(id: string, watch: MissionWatch): StoreResult<Mission> {
    return transact(this.db, 'update the mission', () => {
      const current = this.load(id);
      if (current.watch === watch) return current;
      return { ...current, watch, updatedAt: this.touch(id, 'watch', watch) };
    });
  }

  private load(id: string): Mission {
    const row = this.db.prepare(`SELECT ${MISSION_COLUMNS} FROM missions WHERE id = ?`).get(id) as Row | undefined;
    if (!row) refuse(`No mission with id ${id}.`);
    return toMission(row);
  }

  /** Writes one column and returns the timestamp it was written at. */
  private touch(id: string, column: 'status' | 'watch', value: string): number {
    // The column name is one of two literals from the signature, never caller
    // text, so interpolating it cannot widen the statement.
    const updatedAt = Date.now();
    this.db.prepare(`UPDATE missions SET ${column} = ?, updated_at = ? WHERE id = ?`).run(value, updatedAt, id);
    return updatedAt;
  }
}

export class TaskRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewTask): StoreResult<Task> {
    return attempt('create the task', () => {
      const now = Date.now();
      const task: Task = {
        id: input.id ?? randomUUID(),
        missionId: input.missionId,
        title: input.title,
        description: input.description,
        cwd: input.cwd,
        status: input.status ?? 'proposed',
        priority: input.priority ?? 0,
        dependsOn: dependencies(input.dependsOn),
        acceptance: input.acceptance ?? '',
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(`INSERT INTO tasks (${TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          task.id,
          task.missionId,
          task.title,
          task.description,
          task.cwd,
          task.status,
          task.priority,
          JSON.stringify(task.dependsOn),
          task.acceptance,
          task.createdAt,
          task.updatedAt,
        );
      return task;
    });
  }

  get(id: string): StoreResult<Task | undefined> {
    return attempt('read the task', () => {
      const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as Row | undefined;
      return row ? toTask(row) : undefined;
    });
  }

  /** Dispatch order: priority first, then the order they were written down in. */
  listByMission(missionId: string): StoreResult<Task[]> {
    return attempt('list the mission tasks', () => {
      const rows = this.db
        .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE mission_id = ? ORDER BY priority, created_at`)
        .all(missionId) as Row[];
      return rows.map(toTask);
    });
  }

  /**
   * Moves a task, refusing anything the contract's table does not allow.
   *
   * Read and write share a transaction so the status a decision was made
   * against is the status being replaced. Setting the status a task already
   * has is a no-op rather than a refusal: the transition table describes
   * movement and has no self-loops, while a reducer replaying its own events
   * has to be able to arrive at the same state twice.
   */
  setStatus(id: string, to: TaskStatus): StoreResult<Task> {
    return transact(this.db, 'move the task', () => {
      const row = this.db.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`).get(id) as Row | undefined;
      if (!row) refuse(`No task with id ${id}.`);
      const current = toTask(row);
      if (current.status === to) return current;
      if (!canTransitionTask(current.status, to)) {
        refuse(`A task that is ${current.status} cannot become ${to}.`);
      }
      const updatedAt = Date.now();
      this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, updatedAt, id);
      return { ...current, status: to, updatedAt };
    });
  }
}

/**
 * A budget is optional, and a zero or fractional one is a mistake rather than
 * an unlimited mission — those are two different things, and quietly treating
 * one as the other would give a mission no ceiling at all.
 */
function ceiling(what: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) refuse(`The ${what} must be a whole number above zero.`);
  return value;
}

/** Keeps the shared bounds enforceable at the durable edge, not only in the UI. */
function bounded(what: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    refuse(`The ${what} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

function toMission(row: Row): Mission {
  return {
    id: text(row, 'id'),
    name: text(row, 'name'),
    body: text(row, 'body'),
    status: text(row, 'status') as MissionStatus,
    watch: text(row, 'watch') as MissionWatch,
    pulseSec: int(row, 'pulse_sec'),
    maxChildren: int(row, 'max_children'),
    budgetSec: optInt(row, 'budget_sec'),
    budgetTokens: optInt(row, 'budget_tokens'),
    cwd: text(row, 'cwd'),
    createdAt: int(row, 'created_at'),
    updatedAt: int(row, 'updated_at'),
  };
}

function toTask(row: Row): Task {
  return {
    id: text(row, 'id'),
    missionId: text(row, 'mission_id'),
    title: text(row, 'title'),
    description: text(row, 'description'),
    cwd: text(row, 'cwd'),
    status: text(row, 'status') as TaskStatus,
    priority: int(row, 'priority'),
    dependsOn: idList(row, 'depends_on'),
    acceptance: text(row, 'acceptance'),
    createdAt: int(row, 'created_at'),
    updatedAt: int(row, 'updated_at'),
  };
}
