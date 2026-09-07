import { canTransitionTask, type Task, type TaskStatus } from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { refuse, transact, attempt, type StoreResult } from './db.js';
import { idList, int, optText, text, type Row } from './rows.js';

/**
 * Tasks: the units of work a mission is made of, and their status moves.
 *
 * Split out of `missions.ts` when `current_run_id` pushed that file over the
 * size ceiling. The two were together because a task belongs to a mission, but
 * the shapes are independent and the dependency runs one way — nothing here
 * knows about missions beyond holding an id.
 */

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

/** What a mission runs on unless it says otherwise, and what every mission
 * written before the column existed was in fact running on. */

const TASK_COLUMNS =
  'id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, current_run_id, created_at, updated_at';
/**
 * The same columns minus `current_run_id`, which no new task has.
 *
 * Separate from the read list on purpose: a task is created before it has ever
 * run, so the insert must not claim to supply a value for the attempt under
 * review. Sharing one list is how an added column becomes "11 values for 12
 * columns" at the first write.
 */
const TASK_INSERT =
  'id, mission_id, title, description, cwd, status, priority, depends_on, acceptance, created_at, updated_at';

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
        .prepare(`INSERT INTO tasks (${TASK_INSERT}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
  /** The task's newest attempt that has reported, by attempt number. */
  private reportedRun(taskId: string): string | undefined {
    const row = this.db
      .prepare("SELECT id FROM child_runs WHERE task_id = ? AND state = 'reported' ORDER BY attempt DESC LIMIT 1")
      .get(taskId) as Row | undefined;
    return row === undefined ? undefined : text(row, 'id');
  }

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
      // The attempt under review is written HERE, with the status, because
      // this is the one place every writer of `reported` passes through. It
      // used to be reconstructed from a run-scoped `task_reported` note that
      // each writer had to remember to append, and three of them existed — the
      // pulse, crash recovery, and `set_task_status` over the wire. Each was
      // found the same way: a review noticing that acceptance had validated a
      // second attempt against the first one's verdict.
      //
      // The newest attempt that has reported, read inside this transaction:
      // the run is moved to `reported` before the task is, on every path.
      const run = to === 'reported' ? this.reportedRun(id) : undefined;
      if (to === 'reported') {
        this.db
          .prepare('UPDATE tasks SET status = ?, current_run_id = ?, updated_at = ? WHERE id = ?')
          .run(to, run ?? null, updatedAt, id);
      } else {
        this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, updatedAt, id);
      }
      return { ...current, status: to, updatedAt, ...(run === undefined ? {} : { currentRunId: run }) };
    });
  }
}

/**
 * A budget is optional, and a zero or fractional one is a mistake rather than
 * an unlimited mission — those are two different things, and quietly treating
 * one as the other would give a mission no ceiling at all.
 */
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
    ...(optText(row, 'current_run_id') === undefined ? {} : { currentRunId: optText(row, 'current_run_id') }),
    createdAt: int(row, 'created_at'),
    updatedAt: int(row, 'updated_at'),
  };
}
