import type { ChildRunState, MissionStatus, TaskStatus, WorktreeState } from './mission.js';

/**
 * The state machines, as data.
 *
 * Split out of `mission.ts` when that file reached its ceiling — it had been
 * sitting two lines under it, so the next field of any kind was going to force
 * this. A good seam anyway: everything here answers one question, "can this
 * move there?", and nothing here describes what a mission or a run IS.
 *
 * Re-exported through the package index like everything else, so no importer
 * changes and no caller has to know which file an answer comes from.
 */

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
