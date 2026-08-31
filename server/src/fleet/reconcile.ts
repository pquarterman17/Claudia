import type { ChildRun, Mission, Task } from '@claudia/shared';

/**
 * What the fleet should do next, decided by arithmetic rather than by a model.
 *
 * The plan is explicit that a model may RECOMMEND actions but a deterministic
 * reconciler validates and executes them. This is that reconciler, and it is
 * pure on purpose: given the same mission, tasks and runs it returns the same
 * decisions, so "repeated pulses never duplicate a run" is a property that can
 * be tested rather than hoped for.
 *
 * Nothing here talks to a session, a database or git. It reads state and
 * returns intentions; the caller is the only thing that can spend money.
 *
 * Every refusal is a decision too. A fleet that silently declines to dispatch
 * is indistinguishable from a broken one, and the human's first question is
 * always "why is nothing happening?" — so `hold` and `block` carry reasons in
 * the same shape as `dispatch`.
 */

export interface FleetPolicy {
  /** Runs that may be in flight for this mission at once. */
  maxChildren: number;
  /** Attempts a single task gets before it stops being retried. */
  maxAttempts: number;
}

/** What the mission has spent so far, measured by the caller. */
export interface MissionSpend {
  elapsedSec: number;
  tokens: number;
}

export interface ReconcileInput {
  mission: Mission;
  tasks: readonly Task[];
  /** Every run recorded for this mission, finished ones included: the attempt
   * count and the duplicate-dispatch check are both derived from them. */
  runs: readonly ChildRun[];
  policy: FleetPolicy;
  /** Absent means nothing has been spent yet, not that nothing counts. */
  spend?: MissionSpend;
}

export type Decision =
  /**
   * `key` is what makes execution idempotent, which determinism alone is not.
   * Two pulses reading the same snapshot before either run is recorded both
   * return this same decision — correctly, since nothing has changed. The
   * executor must reserve on this key inside the transaction that writes the
   * run, so the second reservation loses and no second session is launched.
   */
  | { kind: 'dispatch'; taskId: string; attempt: number; reason: string; key: string }
  | { kind: 'block'; taskId: string; reason: string }
  | { kind: 'unblock'; taskId: string; reason: string }
  | { kind: 'hold'; reason: string };

/** A run that is still occupying a slot. */
const ACTIVE_RUN_STATES = new Set(['dispatched', 'running']);

export function reconcile(input: ReconcileInput): Decision[] {
  const { mission, policy } = input;

  // Records are filtered to this mission before anything else looks at them.
  // Found in review: a caller passing a broad query — every task in the store,
  // say — could dispatch another mission's work or consume the wrong mission's
  // capacity, and neither would look like an error anywhere.
  const tasks = input.tasks.filter((t) => t.missionId === mission.id);
  const runs = input.runs.filter((r) => r.missionId === mission.id);

  // Paused is a first-class state, not an absence of work: the plan requires
  // pause/resume to lose nothing, so this returns a reason rather than an
  // empty list that would read as "nothing to do".
  if (mission.status !== 'active') {
    return [{ kind: 'hold', reason: `mission is ${mission.status}` }];
  }
  if (mission.watch !== 'watching') {
    return [{ kind: 'hold', reason: 'mission is paused' }];
  }

  // Budgets are checked before capacity, because being out of budget is a
  // different answer from being busy: one clears itself when a run finishes,
  // the other does not clear until a human raises it.
  const overspent = overBudget(mission, input.spend);
  if (overspent) return [{ kind: 'hold', reason: overspent }];

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cyclic = tasksInCycles(tasks);
  const activeRuns = runs.filter((r) => ACTIVE_RUN_STATES.has(r.state));
  const activeByTask = new Set(activeRuns.map((r) => r.taskId));
  // The HIGHEST attempt, not how many rows there are. Found in review: a task
  // whose history is attempts 1 and 3 has two rows, so counting them proposed
  // attempt 3 — a number already spent, which collides with the run that
  // spent it. Rows go missing (pruning, a failed write); the number on the run
  // is the one that means something.
  const attemptsByTask = new Map<string, number>();
  for (const run of runs) {
    attemptsByTask.set(run.taskId, Math.max(attemptsByTask.get(run.taskId) ?? 0, run.attempt));
  }

  const decisions: Decision[] = [];
  const candidates: Task[] = [];

  for (const task of tasks) {
    if (task.status !== 'ready' && task.status !== 'blocked') continue;

    // A cycle never resolves on its own, and a fleet that waits for it looks
    // identical to one that is working. Say so once, per task.
    if (cyclic.has(task.id)) {
      if (task.status !== 'blocked') decisions.push({ kind: 'block', taskId: task.id, reason: 'dependency cycle' });
      continue;
    }

    const blocker = dependencyBlocker(task, byId);
    if (blocker) {
      if (task.status !== 'blocked') decisions.push({ kind: 'block', taskId: task.id, reason: blocker });
      continue;
    }
    // Already working. This is the check that makes a pulse idempotent: the
    // task's state may not have caught up yet, but its run has.
    if (activeByTask.has(task.id)) continue;

    // Attempts are checked BEFORE any unblock is emitted. Emitting one first
    // meant a task blocked because its attempts were spent was unblocked and
    // re-blocked on every single pulse — two events a minute, for the life of
    // the mission, describing a state that never changed.
    const attempts = attemptsByTask.get(task.id) ?? 0;
    if (attempts >= policy.maxAttempts) {
      if (task.status !== 'blocked') {
        decisions.push({
          kind: 'block',
          taskId: task.id,
          reason: `${attempts} attempt${attempts === 1 ? '' : 's'} spent, limit is ${policy.maxAttempts}`,
        });
      }
      continue;
    }

    if (task.status === 'blocked') {
      decisions.push({ kind: 'unblock', taskId: task.id, reason: 'every dependency is accepted' });
    }
    candidates.push(task);
  }

  // Counted in RUNS, not tasks. Found in review: two active runs against one
  // task collapsed to a single busy slot, so the fleet believed it had room it
  // did not have — and duplicate runs are exactly the state a wedged or
  // half-recovered mission is in.
  // The LOWER of what the human set on this mission and what the server-wide
  // policy allows. Found by audit: `mission.maxChildren` was written, bounded
  // on the way in, and read by no production code — a mission set to one child
  // dispatched eight. That is precisely the shape `overBudget` below has a
  // comment about: visible in the UI, settable by a human, enforcing nothing.
  // Taking the minimum means neither ceiling can be exceeded by raising the
  // other.
  const ceiling = Math.min(mission.maxChildren, policy.maxChildren);
  const capacity = ceiling - activeRuns.length;
  if (candidates.length === 0) {
    // Only worth a hold when there was nothing to say at all; a list of blocks
    // already explains itself.
    if (decisions.length === 0) decisions.push({ kind: 'hold', reason: 'no task is ready' });
    return decisions;
  }
  if (capacity <= 0) {
    decisions.push({
      kind: 'hold',
      reason: `${activeRuns.length} of ${ceiling} children busy; ${candidates.length} task(s) waiting`,
    });
    return decisions;
  }

  // Priority first, then creation order, so two pulses over unchanged state
  // dispatch the same task — the tie-break is not decoration, it is what makes
  // the function deterministic.
  candidates.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

  for (const task of candidates.slice(0, capacity)) {
    const attempt = (attemptsByTask.get(task.id) ?? 0) + 1;
    decisions.push({
      kind: 'dispatch',
      taskId: task.id,
      attempt,
      reason: attempt === 1 ? 'dependencies satisfied' : `retry ${attempt} of ${policy.maxAttempts}`,
      key: dispatchKey(mission.id, task.id, attempt),
    });
  }
  if (candidates.length > capacity) {
    decisions.push({
      kind: 'hold',
      reason: `${candidates.length - capacity} task(s) waiting on a free slot`,
    });
  }
  return decisions;
}

/**
 * Whether the mission has spent what it was given.
 *
 * Found in review: these were persisted and never read, which is the worst
 * shape for a limit — visible in the UI, settable by a human, and enforcing
 * nothing. A budget nobody checks is a promise the app is quietly breaking.
 */
function overBudget(mission: Mission, spend: MissionSpend | undefined): string | undefined {
  if (!spend) return undefined;
  // A spend nobody could measure is not a spend inside the budget. Found by
  // audit: `NaN >= x` is false, so a single unusable number switched both
  // ceilings off silently — and `tokens` is summed from model usage, where one
  // missing field produces NaN. Refusing to dispatch on an unreadable spend is
  // the same bias the rest of the fleet takes: an unknown is not permission.
  const unreadable = [
    mission.budgetSec !== undefined && !Number.isFinite(spend.elapsedSec) ? 'elapsed time' : undefined,
    mission.budgetTokens !== undefined && !Number.isFinite(spend.tokens) ? 'token spend' : undefined,
  ].filter((what): what is string => what !== undefined);
  if (unreadable.length > 0) return `cannot read its ${unreadable.join(' or ')}`;
  if (mission.budgetSec !== undefined && spend.elapsedSec >= mission.budgetSec) {
    return `spent its ${mission.budgetSec}s budget`;
  }
  if (mission.budgetTokens !== undefined && spend.tokens >= mission.budgetTokens) {
    return `spent its ${mission.budgetTokens}-token budget`;
  }
  return undefined;
}

/**
 * The reservation key for one attempt at one task.
 *
 * Deliberately not random: two pulses that reach the same conclusion must
 * produce the SAME key, so the store can reject the duplicate. A random id
 * would make every pulse look like new work, which is the bug it exists to
 * prevent.
 */
export function dispatchKey(missionId: string, taskId: string, attempt: number): string {
  return `dispatch:${missionId}:${taskId}:${attempt}`;
}

/**
 * The first reason a task cannot start, or undefined when it can.
 *
 * A dependency that FAILED is reported differently from one still running,
 * because they need different things from the human: one is patience, the
 * other is a decision.
 */
function dependencyBlocker(task: Task, byId: Map<string, Task>): string | undefined {
  for (const id of task.dependsOn) {
    const dep = byId.get(id);
    if (!dep) return `depends on ${id}, which does not exist`;
    if (dep.status === 'accepted') continue;
    if (dep.status === 'failed' || dep.status === 'cancelled') {
      return `depends on "${dep.title}", which is ${dep.status}`;
    }
    return `waiting on "${dep.title}"`;
  }
  return undefined;
}

/**
 * Tasks that can never start because their dependencies loop.
 *
 * Worth its own pass rather than being left to look like ordinary waiting: a
 * cycle is a data error a human has to fix, and the fleet would otherwise sit
 * on it forever reporting that it is waiting for something.
 */
function tasksInCycles(tasks: readonly Task[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cyclic = new Set<string>();

  const walk = (id: string, stack: string[]): void => {
    const seen = state.get(id);
    if (seen === 'done') return;
    if (seen === 'visiting') {
      // Everything from where the cycle closes to here is part of it.
      for (const member of stack.slice(stack.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) walk(dep, [...stack, id]);
    state.set(id, 'done');
  };

  for (const task of tasks) walk(task.id, []);
  return cyclic;
}
