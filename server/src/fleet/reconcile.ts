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

export interface ReconcileInput {
  mission: Mission;
  tasks: readonly Task[];
  /** Every run recorded for this mission, finished ones included: the attempt
   * count and the duplicate-dispatch check are both derived from them. */
  runs: readonly ChildRun[];
  policy: FleetPolicy;
}

export type Decision =
  | { kind: 'dispatch'; taskId: string; attempt: number; reason: string }
  | { kind: 'block'; taskId: string; reason: string }
  | { kind: 'unblock'; taskId: string; reason: string }
  | { kind: 'hold'; reason: string };

/** A run that is still occupying a slot. */
const ACTIVE_RUN_STATES = new Set(['dispatched', 'running']);

export function reconcile(input: ReconcileInput): Decision[] {
  const { mission, tasks, runs, policy } = input;

  // Paused is a first-class state, not an absence of work: the plan requires
  // pause/resume to lose nothing, so this returns a reason rather than an
  // empty list that would read as "nothing to do".
  if (mission.status !== 'active') {
    return [{ kind: 'hold', reason: `mission is ${mission.status}` }];
  }
  if (mission.watch !== 'watching') {
    return [{ kind: 'hold', reason: 'mission is paused' }];
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cyclic = tasksInCycles(tasks);
  const activeByTask = new Set(
    runs.filter((r) => ACTIVE_RUN_STATES.has(r.state)).map((r) => r.taskId),
  );
  const attemptsByTask = new Map<string, number>();
  for (const run of runs) attemptsByTask.set(run.taskId, (attemptsByTask.get(run.taskId) ?? 0) + 1);

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
    if (task.status === 'blocked') {
      decisions.push({ kind: 'unblock', taskId: task.id, reason: 'every dependency is accepted' });
    }

    // Already working. This is the check that makes a pulse idempotent: the
    // task's state may not have caught up yet, but its run has.
    if (activeByTask.has(task.id)) continue;

    const attempts = attemptsByTask.get(task.id) ?? 0;
    if (attempts >= policy.maxAttempts) {
      decisions.push({
        kind: 'block',
        taskId: task.id,
        reason: `${attempts} attempt${attempts === 1 ? '' : 's'} spent, limit is ${policy.maxAttempts}`,
      });
      continue;
    }
    candidates.push(task);
  }

  const capacity = policy.maxChildren - activeByTask.size;
  if (candidates.length === 0) {
    // Only worth a hold when there was nothing to say at all; a list of blocks
    // already explains itself.
    if (decisions.length === 0) decisions.push({ kind: 'hold', reason: 'no task is ready' });
    return decisions;
  }
  if (capacity <= 0) {
    decisions.push({
      kind: 'hold',
      reason: `${activeByTask.size} of ${policy.maxChildren} children busy; ${candidates.length} task(s) waiting`,
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
