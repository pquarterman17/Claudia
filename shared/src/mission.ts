import type { AgentKind } from './index.js';

/**
 * The durable side of the fleet: what survives a restart.
 *
 * Everything else in Claudia is memory-resident on purpose — a session is a
 * live process, and when it is gone it is gone. A mission is the opposite: it
 * is a standing intention that outlives the server, the browser, and the
 * sessions it dispatched, so it needs identity, an explicit state machine, and
 * an append-only history that a restart can replay.
 *
 * The state machines are DATA here, not scattered `if` statements, because two
 * halves of the app and two different agents implement against them. A
 * transition table that can be read and tested is the only way "blocked" means
 * the same thing to the reconciler, the store, and the UI.
 *
 * See plans/ARGUS_PARITY_PLAN.md for where this sits.
 */

/** Whether the manager is acting on a mission, or only holding it. */
export type MissionWatch = 'watching' | 'paused';

export type MissionStatus = 'active' | 'completed' | 'archived';

/**
 * A task's life, from proposed to accepted.
 *
 * `reported` and `accepted` are deliberately separate states. A child saying
 * it is done is a claim; acceptance is a decision made against evidence. The
 * plan's whole completion contract rests on those not being the same word.
 */
export type TaskStatus =
  | 'proposed'
  | 'ready'
  | 'blocked'
  | 'running'
  | 'reported'
  | 'accepted'
  | 'failed'
  | 'cancelled';

export type ChildRunState = 'dispatched' | 'running' | 'reported' | 'stopped' | 'failed';

/** What a worktree is to the fleet, not what git thinks of it. */
export type WorktreeState = 'active' | 'idle' | 'stale' | 'archived' | 'removed';

export type EscalationSeverity = 'info' | 'warning' | 'blocking';

/**
 * The roster as data, so the wire checker and the store cannot drift apart —
 * the same reason `AGENT_KINDS` is a list rather than only a union.
 */
export const ESCALATION_RESOLUTIONS = ['pending', 'approved', 'denied', 'expired', 'withdrawn'] as const;

export type EscalationResolution = (typeof ESCALATION_RESOLUTIONS)[number];

/**
 * The resolutions a person may choose.
 *
 * Narrower than the column on purpose. `pending` is not a resolution and the
 * store refuses it. `expired` belongs to a clock — nothing implements expiry
 * yet, and a human marking something expired would be backdating a decision
 * they actually made. Approving, denying and withdrawing are the three a
 * person can honestly mean.
 */
export const HUMAN_RESOLUTIONS = ['approved', 'denied', 'withdrawn'] as const;

export type HumanResolution = (typeof HUMAN_RESOLUTIONS)[number];

export function isHumanResolution(value: unknown): value is HumanResolution {
  return typeof value === 'string' && (HUMAN_RESOLUTIONS as readonly string[]).includes(value);
}

/** Who caused an event. Children are never trusted; humans always are. */
export type FleetActor = 'human' | 'manager' | 'child' | 'system';

export interface Mission {
  id: string;
  name: string;
  /** The standing intention, in the human's words. */
  body: string;
  status: MissionStatus;
  watch: MissionWatch;
  /** Seconds between reconciliations. See PULSE_MIN_SEC / PULSE_MAX_SEC. */
  pulseSec: number;
  maxChildren: number;
  /** Wall-clock ceiling for the whole mission, in seconds. Absent means none.
   * Enforced by the dispatcher, not here; stored so it survives a restart. */
  budgetSec?: number;
  /** Token ceiling across every child. Absent means none. */
  budgetTokens?: number;
  /** Repository the mission's tasks default to. */
  cwd: string;
  /**
   * Which harness this mission's children run on.
   *
   * On the mission and not on the task: it describes how a body of work should
   * be done, not one unit of it, and a task inherits it. `ChildRun.agent`
   * records what a given attempt actually ran, which is the same value today
   * and the seam a retry on the other harness would use.
   */
  agent: AgentKind;
  /**
   * The command that decides whether a finished child's work is good.
   *
   * Absent means nobody checks, and that is the default: this is run
   * unattended in a worktree, so it has to be a thing the human wrote down on
   * purpose rather than something guessed from the repository. Without it the
   * evidence carries no test results, `missingEvidence` reports the gap, and
   * every verdict is `needs_human` — which is exactly what happened to every
   * mission before this column existed.
   *
   * On the mission for the same reason `agent` is: it describes a repository's
   * idea of "green", not one unit of work.
   */
  verify?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Task {
  id: string;
  missionId: string;
  title: string;
  description: string;
  cwd: string;
  status: TaskStatus;
  /** Lower sorts first; ties break on creation order. */
  priority: number;
  /** Task ids that must reach `accepted` before this one may be dispatched. */
  dependsOn: string[];
  /** What "done" means, in terms a human can check against evidence. */
  acceptance: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChildRun {
  id: string;
  missionId: string;
  taskId: string;
  /** The live session, while there is one. Absent once it has ended. */
  sessionId?: string;
  worktreeId?: string;
  /**
   * Tokens this attempt has spent, input and output together.
   *
   * On the RUN rather than only on the session, because a session that has
   * ended has taken its counts with it — and a mission's budget is spent by
   * every attempt it has ever made, not by the ones still alive. Absent means
   * nobody could read it, which `spendOf` treats as an unknown rather than as
   * zero: a comfortable zero would read as headroom the mission may not have.
   */
  tokens?: number;
  /** Which agent ran it, so a retry can pick the other one — typed, because
   * 'pick the other one' is not a decision you can make about free text. */
  agent: AgentKind;
  /** 1-based; a retry is a new run, never a mutation of the old one. */
  attempt: number;
  state: ChildRunState;
  startedAt: number;
  endedAt?: number;
  /** Why it ended, when it ended for a reason worth naming. */
  terminalReason?: string;
}

/**
 * A worktree the fleet believes it owns.
 *
 * `baseSha` and `owner` are what make ownership provable. A directory that
 * merely exists at the expected path proves nothing — it may be a previous
 * run's, or a human's — and the plan's rule is that no run claims or deletes
 * an unverified worktree.
 */
export interface WorktreeRecord {
  id: string;
  repo: string;
  path: string;
  branch: string;
  baseSha: string;
  ownerMissionId?: string;
  ownerTaskId?: string;
  state: WorktreeState;
  /** True when it holds uncommitted work, which blocks automatic cleanup. */
  dirty: boolean;
  lastSeenAt: number;
  createdAt: number;
}

/**
 * One entry in the append-only history.
 *
 * `seq` is assigned by the store and is monotonic across the whole log, which
 * is what makes resync-by-sequence possible for a browser that fell behind.
 * `idempotencyKey` is what makes a repeated pulse safe: the same key never
 * appends twice.
 */
export interface FleetEvent {
  seq: number;
  missionId: string;
  /** Denormalised so the timeline can filter without parsing `payload`, which
   * is untyped by design and must never be reached into for structure. */
  taskId?: string;
  runId?: string;
  actor: FleetActor;
  kind: string;
  /** Typed per `kind`; stored as JSON and never executed. */
  payload: unknown;
  at: number;
  idempotencyKey?: string;
}

export interface Escalation {
  id: string;
  missionId: string;
  taskId?: string;
  runId?: string;
  /** Who is asking. A `child` source is untrusted input by definition. */
  source: FleetActor;
  /** The capability or decision being requested, e.g. "git push". */
  request: string;
  reason: string;
  severity: EscalationSeverity;
  resolution: EscalationResolution;
  /** When an unanswered request stops being offered. Without this the
   * `expired` resolution is a state nothing can ever reach. */
  expiresAt?: number;
  createdAt: number;
  resolvedAt?: number;
  /** Freeform note from whoever resolved it. */
  resolutionNote?: string;
  /**
   * Stable key for the condition that raised this, when there is one.
   *
   * A watchdog tick that finds a stuck run produces the same escalation every
   * time. Unique in the store, so a pulse every minute updates nobody's inbox
   * rather than filling it.
   */
  idempotencyKey?: string;
}

/**
 * Bounds the plan fixes, shared so the server enforces and the UI offers the
 * same numbers rather than each carrying its own copy.
 */
export const PULSE_MIN_SEC = 30;
export const PULSE_MAX_SEC = 4 * 60 * 60;
export const PULSE_DEFAULT_SEC = 60;
export const MAX_CHILDREN_PRESETS = [1, 2, 4, 8] as const;
export const MAX_CHILDREN_DEFAULT = 4;
/** Temporary, until the 16-child scale gate passes. See the plan's defaults. */
export const MAX_CHILDREN_CEILING = 12;

/**
 * The fleet's own ceilings, applied on top of whatever each mission asks for.
 *
 * Two limits, one for each way a fleet runs away: `maxChildren` bounds how
 * much it spends at once, `maxAttempts` bounds how long it keeps paying for a
 * task that will not pass. A mission carries its own `maxChildren`; this is
 * the fleet-wide cap the manager applies over the top of it, so lowering it
 * throttles every mission at once without editing any of them.
 *
 * Shared rather than server-local because the same numbers have to be
 * enforced by the pulse, stored in settings, and offered by the UI. Two copies
 * of a limit is one limit and one lie.
 */
export interface FleetLimits {
  /** Runs that may be in flight across the fleet at once. */
  maxChildren: number;
  /** Attempts a single task gets before it stops being retried. */
  maxAttempts: number;
}

/** More than this is a loop with extra steps, not a retry. */
export const MAX_ATTEMPTS_CEILING = 10;
export const MAX_ATTEMPTS_DEFAULT = 3;

/**
 * The shipped limits: attempts bounded, children left to each mission.
 *
 * `maxChildren` defaults to the ceiling on purpose. A mission already picks
 * its own child limit and the pulse takes the lower of the two, so a
 * fleet-wide default below the ceiling would silently override a choice the
 * human made per mission. The fleet cap exists to be *lowered* when a machine
 * cannot take the load, not to be the first thing that binds.
 */
export const DEFAULT_FLEET_LIMITS: FleetLimits = Object.freeze({
  maxChildren: MAX_CHILDREN_CEILING,
  maxAttempts: MAX_ATTEMPTS_DEFAULT,
});

/**
 * Reads limits from somewhere that could be wrong — a hand-edited settings
 * file, an older version's record, a client — and answers with limits the
 * fleet can actually run on.
 *
 * Clamped rather than refused. The reconciler treats an unusable policy as a
 * reason to escalate every task, so a settings file with a typo in it would
 * take the whole fleet down; falling back to the shipped number for the field
 * that is wrong keeps the rest of the record. Fractions are rounded because
 * "2.5 children" has no meaning at the point where it is compared with a
 * count.
 */
export function usableFleetLimits(value: unknown): FleetLimits {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return {
    maxChildren: clampLimit(raw['maxChildren'], DEFAULT_FLEET_LIMITS.maxChildren, MAX_CHILDREN_CEILING),
    maxAttempts: clampLimit(raw['maxAttempts'], DEFAULT_FLEET_LIMITS.maxAttempts, MAX_ATTEMPTS_CEILING),
  };
}

function clampLimit(value: unknown, fallback: number, ceiling: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(ceiling, Math.max(1, Math.round(value)));
}

/**
 * The attempt whose report is on the table for one task.
 *
 * Here rather than in either caller because BOTH have to answer it the same
 * way. The board decides from it whether to offer a plain accept; the server
 * decides from it which verdict `accept_task` validates against. When the two
 * disagreed, the panel offered a decision the server then refused — or
 * demanded a reason for evidence the server considered fine — and in both
 * directions the human was deciding about a different worktree than the one
 * being checked. Two implementations with two comments each asserting the
 * other must match is the arrangement that produced that, so there is one.
 *
 * The rule: the run named by the newest `task_reported`. The server writes
 * that note in exactly one place — the branch of `applyTaskIntent` that moves
 * a task INTO `reported` — so it names the claim that put the task in the
 * state the panel renders for and the command acts on.
 *
 * It is NOT the highest attempt, and not the newest run named by any event.
 * Runs of one task overlap and can finish out of order: a second attempt
 * dispatched while the first was stuck can report first, hit the `stillHeld`
 * branch, and never move the task at all. Both of those readings answered with
 * a run nobody is looking at.
 *
 * By `seq`, NOT by position. This took the last match in the array, which made
 * the answer depend on an ordering the signature never asked for: the board
 * passes an ascending slice and the server a descending page, so the server
 * got the OLDEST report in its window and accepted a second attempt on the
 * first one's verdict — the exact failure this function exists to prevent,
 * with the two callers reading the same helper in opposite directions.
 *
 * `undefined` means no such note is in reach — a log written before runs were
 * denormalised onto events, or a task moved to `reported` by hand. Each caller
 * decides what to do there; neither should pretend it knows.
 */
export function currentRunFor(events: readonly FleetEvent[]): string | undefined {
  let current: string | undefined;
  let currentSeq = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.kind !== 'task_reported' || event.runId === undefined) continue;
    if (event.seq <= currentSeq) continue;
    current = event.runId;
    currentSeq = event.seq;
  }
  return current;
}

/**
 * Whether one recorded test result can be read as a result at all.
 *
 * In `shared` because both ends have to agree on it. The server refuses
 * evidence this rejects (`malformedEvidence` calls the run malformed and
 * `judge` returns `reject`), and the board counts what it rejects as unread —
 * which is what keeps the plain one-click accept off a result nobody could
 * parse. Two copies of the rule, kept in step by a comment, is how the board
 * ends up treating as readable something the server calls malformed.
 *
 * `command` must be a non-empty string and `exitCode` a safe integer:
 * `typeof NaN` is 'number', so the looser check let `failed (NaN)` render as a
 * result somebody had read.
 */
export function readableTest(value: unknown): { command: string; exitCode: number } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const test = value as Record<string, unknown>;
  const command = test['command'];
  const exitCode = test['exitCode'];
  if (typeof command !== 'string' || command.trim() === '') return undefined;
  if (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode)) return undefined;
  return { command, exitCode };
}
