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

export type EscalationResolution = 'pending' | 'approved' | 'denied' | 'expired' | 'withdrawn';

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
 * Legal transitions, as data.
 *
 * Written down rather than enforced ad hoc because the reconciler, the store
 * and the UI each have their own reason to ask "can this move there?", and
 * three independent answers is how a fleet ends up with a task that is both
 * running and cancelled.
 */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  // Completed is not terminal: finishing a mission and then thinking of one
  // more task is the ordinary case, and forcing a new mission for it would
  // split the history of one intention across two records.
  active: ['completed', 'archived'],
  completed: ['active', 'archived'],
  archived: ['active'],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  proposed: ['ready', 'cancelled'],
  ready: ['blocked', 'running', 'cancelled'],
  blocked: ['ready', 'cancelled'],
  // A dispatched task can come back blocked: a dependency may have been
  // reopened, or its worktree taken away, while it was working.
  running: ['reported', 'failed', 'blocked', 'cancelled'],
  // Not accepted automatically. Evidence is reviewed, and review can send it back.
  reported: ['accepted', 'failed', 'ready', 'cancelled'],
  // Terminal states, except that a retry starts a NEW run rather than
  // resurrecting this one — so nothing leaves them.
  accepted: [],
  failed: ['ready', 'cancelled'],
  cancelled: [],
};

export const RUN_TRANSITIONS: Readonly<Record<ChildRunState, readonly ChildRunState[]>> = {
  dispatched: ['running', 'failed', 'stopped'],
  running: ['reported', 'failed', 'stopped'],
  reported: ['stopped', 'failed'],
  stopped: [],
  failed: [],
};

export const WORKTREE_TRANSITIONS: Readonly<Record<WorktreeState, readonly WorktreeState[]>> = {
  active: ['idle', 'stale', 'archived'],
  idle: ['active', 'stale', 'archived'],
  stale: ['active', 'archived'],
  archived: ['removed', 'active'],
  removed: [],
};

export function canTransitionMission(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

/**
 * Whether an explicitly named route is legal, hop by hop.
 *
 * Deliberately a CHECKER and not a path-finder. The first version of this
 * searched for the shortest legal route, which is the wrong mechanism: where
 * several routes exist they do not mean the same thing. Asked to get a crashed
 * task from `running` to `ready`, the search returned `running -> reported ->
 * ready` — the same length as the right answer and a lie, since `reported`
 * means a child claimed the work was done. A module that knows WHY a thing is
 * moving is the only thing that can pick the route; this just refuses the ones
 * the state machine forbids.
 *
 * An empty route is legal and means "already there".
 */
export function isLegalRoute<S extends string>(
  from: S,
  route: readonly S[],
  table: Readonly<Record<S, readonly S[]>>,
): boolean {
  let at = from;
  for (const next of route) {
    if (!(table[at] ?? []).includes(next)) return false;
    at = next;
  }
  return true;
}

/** True when `to` is a legal next state for a task in `from`. */
export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionRun(from: ChildRunState, to: ChildRunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionWorktree(from: WorktreeState, to: WorktreeState): boolean {
  return WORKTREE_TRANSITIONS[from].includes(to);
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
