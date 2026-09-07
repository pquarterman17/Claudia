import {
  canTransitionMission,
  MAX_CHILDREN_CEILING,
  MAX_CHILDREN_DEFAULT,
  PULSE_DEFAULT_SEC,
  PULSE_MAX_SEC,
  PULSE_MIN_SEC,
  type AgentKind,
  type Mission,
  type MissionStatus,
  type MissionWatch,
  verifyCommandProblem,
} from '@claudia/shared';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { attempt, refuse, transact, type StoreResult } from './db.js';
import { agentKind, int, optInt, optText, text, type Row } from './rows.js';

/**
 * Missions and their tasks.
 *
 * The repositories own two things the callers should not have to think about:
 * the row/domain translation, and the transition rules. Status moves go through
 * canTransitionTask from the domain contract rather than a second copy of the
 * table living here — the whole point of that table being data is that the
 * store, the reconciler and the UI cannot disagree about what "blocked" allows.
 */

export type NewMission = Omit<
  Mission,
  'id' | 'createdAt' | 'updatedAt' | 'status' | 'watch' | 'pulseSec' | 'maxChildren' | 'agent'
> & {
  /** Supplied when the caller needs a known id (a replay, a fixture). */
  id?: string;
  status?: MissionStatus;
  watch?: MissionWatch;
  pulseSec?: number;
  maxChildren?: number;
  /** Defaults to Claude, which is what every mission written before this
   * column existed actually ran on. */
  agent?: AgentKind;
};

/**
 * Checked on the way IN, like `dependencies` above and for the same reason.
 *
 * A verify command that cannot mean what it says is worse than none: parsed as
 * arguments, `npm test && npm run lint` hands npm four words it does not
 * understand, npm exits non-zero, and every finished child is REJECTED for the
 * rest of the mission's life. Refusing it here means the person who typed it
 * finds out, rather than the work.
 */
function verifyCommand(value: string): string {
  const problem = verifyCommandProblem(value);
  if (problem !== undefined) refuse(problem);
  return value.trim();
}

const DEFAULT_AGENT: AgentKind = 'claude';

const MISSION_COLUMNS =
  'id, name, body, status, watch, pulse_sec, max_children, budget_sec, budget_tokens, cwd, agent, verify, created_at, updated_at';

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
        // Checked, not cast. The column has a CHECK too, but a refusal that
        // names the value beats a constraint violation that names the column.
        agent: agentKind(input.agent ?? DEFAULT_AGENT),
        // Blank is not a command. A caller that sends an empty string means
        // "nothing checks this", and storing it would make `verify` a value
        // the runner has to defend against on every read instead of once here.
        ...(input.verify?.trim() ? { verify: verifyCommand(input.verify) } : {}),
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare(`INSERT INTO missions (${MISSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          mission.agent,
          mission.verify ?? null,
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

  /**
   * Sets, or clears, the command this mission's work is checked with.
   *
   * The empty string clears it, which is the only way back to "nobody checks":
   * a mission whose command has become wrong is more dangerous than one with
   * none, because a failing check that is failing for its own reasons rejects
   * good work.
   */
  setVerify(id: string, verify: string): StoreResult<Mission> {
    return transact(this.db, 'update the mission', () => {
      const current = this.load(id);
      const next = verify.trim() === '' ? undefined : verifyCommand(verify);
      if (current.verify === next) return current;
      const updatedAt = Date.now();
      this.db.prepare('UPDATE missions SET verify = ?, updated_at = ? WHERE id = ?').run(next ?? null, updatedAt, id);
      const { verify: _dropped, ...rest } = current;
      return { ...rest, ...(next !== undefined ? { verify: next } : {}), updatedAt };
    });
  }

  /**
   * The ceilings this mission may spend against, or none.
   *
   * Both at once, and `undefined` means NONE rather than unchanged: a caller
   * that wants to clear one has to be able to say so, and a partial update
   * would make "no time budget" indistinguishable from "do not touch the time
   * budget". The board sends both because it is showing both.
   *
   * The same `ceiling` check `create` uses, so a limit written here cannot be
   * a shape `create` would have refused — the two paths were reaching the same
   * column and only one of them was checking.
   */
  setBudget(id: string, budget: { budgetSec?: number; budgetTokens?: number }): StoreResult<Mission> {
    return transact(this.db, 'update the mission', () => {
      const current = this.load(id);
      const budgetSec = ceiling('time budget', budget.budgetSec);
      const budgetTokens = ceiling('token budget', budget.budgetTokens);
      if (current.budgetSec === budgetSec && current.budgetTokens === budgetTokens) return current;
      const updatedAt = Date.now();
      this.db
        .prepare('UPDATE missions SET budget_sec = ?, budget_tokens = ?, updated_at = ? WHERE id = ?')
        .run(budgetSec ?? null, budgetTokens ?? null, updatedAt, id);
      const { budgetSec: _sec, budgetTokens: _tokens, ...rest } = current;
      return {
        ...rest,
        ...(budgetSec !== undefined ? { budgetSec } : {}),
        ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        updatedAt,
      };
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
    agent: agentKind(text(row, 'agent')),
    ...(optText(row, 'verify') !== undefined ? { verify: optText(row, 'verify') as string } : {}),
    createdAt: int(row, 'created_at'),
    updatedAt: int(row, 'updated_at'),
  };
}

