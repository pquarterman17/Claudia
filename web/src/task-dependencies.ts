import { dependencyState, isTerminalDependencyStatus, type DependencyState, type Task } from '@claudia/shared';

export interface TaskDependencyView {
  id: string;
  title: string;
  state: DependencyState;
}

/**
 * Dependencies a newly proposed task may name.
 *
 * Failed or cancelled work can never satisfy a dependency, so offering either
 * would let the UI create a task that is permanently blocked on purpose.
 * Accepted work remains useful: it lets a person record why the new task is
 * now possible, even though the dependency is already satisfied.
 */
export function dependencyChoices(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => !isTerminalDependencyStatus(task.status))
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Resolve stored ids without hiding corrupt or stale references. */
export function dependencyView(
  task: Task,
  byId: ReadonlyMap<string, Task>,
  cyclic: ReadonlySet<string>,
): TaskDependencyView[] {
  return task.dependsOn.map((id) => ({
    id,
    title: byId.get(id)?.title ?? `Unknown task ${id}`,
    state: dependencyState(task, id, byId, cyclic),
  }));
}

/** Preserve identity when pruning has nothing to do, avoiding a render loop. */
export function retainedDependencies(current: string[], available: ReadonlySet<string>): string[] {
  const retained = current.filter((id) => available.has(id));
  return retained.length === current.length ? current : retained;
}
