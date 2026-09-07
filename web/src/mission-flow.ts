import type { MissionWatch, Task, TaskStatus } from '@claudia/shared';

export interface FlowTask {
  id: string;
  title: string;
  status: TaskStatus;
  dependencyTitles: string[];
  unresolvedDependencies: string[];
}

export interface MissionFlowModel {
  tasks: FlowTask[];
  counts: Map<TaskStatus, number>;
  next: string;
}

const STATUS_ORDER: readonly TaskStatus[] = [
  'reported', 'failed', 'blocked', 'running', 'ready', 'proposed', 'accepted', 'cancelled',
];

/** A compact, truthful overview derived only from durable task state. */
export function missionFlow(tasks: readonly Task[], watch: MissionWatch): MissionFlowModel {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const counts = new Map<TaskStatus, number>();
  for (const status of STATUS_ORDER) {
    const count = tasks.filter((task) => task.status === status).length;
    if (count > 0) counts.set(status, count);
  }

  const flowTasks = [...tasks]
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.priority - b.priority || a.createdAt - b.createdAt)
    .map((task) => {
      const dependencies = task.dependsOn.map((id) => ({ id, task: byId.get(id) }));
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        dependencyTitles: dependencies.map(({ id, task: dependency }) => dependency?.title ?? `Unknown task ${id}`),
        unresolvedDependencies: dependencies
          .filter(({ task: dependency }) => dependency?.status !== 'accepted')
          .map(({ id, task: dependency }) => dependency?.title ?? `Unknown task ${id}`),
      };
    });

  return { tasks: flowTasks, counts, next: nextAction(flowTasks, watch) };
}

function nextAction(tasks: readonly FlowTask[], watch: MissionWatch): string {
  const reported = tasks.find((task) => task.status === 'reported');
  if (reported) return `Review “${reported.title}”`;
  const failed = tasks.find((task) => task.status === 'failed');
  if (failed) return `Decide how to recover “${failed.title}”`;
  const blocked = tasks.find((task) => task.status === 'blocked' && task.unresolvedDependencies.length > 0);
  if (blocked) return `Unblock “${blocked.title}” by finishing ${blocked.unresolvedDependencies.join(', ')}`;
  const proposed = tasks.find((task) => task.status === 'proposed');
  if (proposed) return `Approve or cancel “${proposed.title}”`;
  if (watch === 'paused' && tasks.some((task) => task.status === 'ready')) return 'Start watching to dispatch ready work';
  if (tasks.some((task) => task.status === 'running')) return 'Children are working; watch for a claim or escalation';
  if (tasks.some((task) => task.status === 'ready')) return 'Ready work is waiting for the next pulse';
  if (tasks.length === 0) return 'Add a task, then approve it for dispatch';
  return 'No task needs action';
}
