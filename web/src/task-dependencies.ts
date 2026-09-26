import type { Task } from '@claudia/shared';

export interface TaskDependencyView {
  id: string;
  title: string;
  status?: Task['status'];
  missing: boolean;
}

/**
 * Dependencies a newly proposed task may name.
 *
 * Cancelled work can never satisfy a dependency, so offering it in the picker
 * would let the UI create a task that is permanently blocked on purpose.
 * Accepted work remains useful: it lets a person record why the new task is
 * now possible, even though the dependency is already satisfied.
 */
export function dependencyChoices(tasks: readonly Task[]): Task[] {
  return tasks.filter((task) => task.status !== 'cancelled');
}

/** Resolve stored ids without hiding corrupt or stale references. */
export function dependencyView(task: Task, tasks: readonly Task[]): TaskDependencyView[] {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return task.dependsOn.map((id) => {
    const dependency = byId.get(id);
    return dependency
      ? { id, title: dependency.title, status: dependency.status, missing: false }
      : { id, title: `Unknown task ${id}`, missing: true };
  });
}

