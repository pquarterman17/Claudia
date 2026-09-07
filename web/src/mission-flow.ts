import type { Escalation, FleetLimits, Mission, Task, TaskStatus } from '@claudia/shared';
import type { Spend } from './components/MissionBudget';

export type DependencyState = 'satisfied' | 'waiting' | 'terminal' | 'missing' | 'cycle';
export interface FlowTask { id: string; title: string; status: TaskStatus; dependencies: { title: string; state: DependencyState }[]; }
export interface MissionFlowModel { tasks: FlowTask[]; counts: Map<TaskStatus, number>; next: string; }

const STATUS_ORDER: readonly TaskStatus[] = ['reported', 'failed', 'blocked', 'running', 'ready', 'proposed', 'accepted', 'cancelled'];

/** A compact overview. Predictions use the same durable inputs as the reconciler. */
export function missionFlow(tasks: readonly Task[], mission: Mission, spend: Spend | undefined, limits: FleetLimits, escalations: readonly Escalation[]): MissionFlowModel {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cyclic = tasksInCycles(tasks);
  const unorderedCounts = new Map<TaskStatus, number>();
  for (const task of tasks) unorderedCounts.set(task.status, (unorderedCounts.get(task.status) ?? 0) + 1);
  const counts = new Map(STATUS_ORDER.flatMap((status) => {
    const count = unorderedCounts.get(status);
    return count === undefined ? [] : [[status, count] as const];
  }));
  const flowTasks = [...tasks]
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.priority - b.priority || a.createdAt - b.createdAt)
    .map((task) => ({ id: task.id, title: task.title, status: task.status, dependencies: task.dependsOn.map((id) => dependency(id, task.id, byId, cyclic)) }));
  return { tasks: flowTasks, counts, next: nextAction(flowTasks, mission, spend, limits, escalations) };
}

function nextAction(tasks: readonly FlowTask[], mission: Mission, spend: Spend | undefined, limits: FleetLimits, escalations: readonly Escalation[]): string {
  const escalation = escalations.find((item) => item.resolution === 'pending');
  if (escalation) return `Resolve “${escalation.request}” in the decision inbox`;
  if (mission.status !== 'active') return `Mission is ${mission.status}`;
  if (mission.watch !== 'watching') return 'Start watching to continue this mission';
  const budget = budgetProblem(mission, spend);
  if (budget) return budget;
  if (!Number.isSafeInteger(Math.min(mission.maxChildren, limits.maxChildren))) return 'Repair the unreadable child limit';
  const reported = tasks.find((task) => task.status === 'reported');
  if (reported) return `Review “${reported.title}”`;
  const failed = tasks.find((task) => task.status === 'failed');
  if (failed) return `Decide how to recover “${failed.title}”`;
  const blocked = tasks.find((task) => task.status === 'blocked');
  if (blocked) {
    const broken = blocked.dependencies.find((item) => item.state === 'terminal' || item.state === 'missing' || item.state === 'cycle');
    if (broken) return `Repair the ${broken.state} dependency blocking “${blocked.title}”`;
    const waiting = blocked.dependencies.filter((item) => item.state === 'waiting');
    if (waiting.length > 0) return `Wait for ${waiting.map((item) => item.title).join(', ')} before “${blocked.title}”`;
    return `Inspect “${blocked.title}”; its attempts may be exhausted`;
  }
  const proposed = tasks.find((task) => task.status === 'proposed');
  if (proposed) return `Approve or cancel “${proposed.title}”`;
  if (tasks.some((task) => task.status === 'running')) return 'Children are working; watch for a claim or escalation';
  if (tasks.some((task) => task.status === 'ready')) return 'Ready work is waiting for capacity or the next pulse';
  return 'No task needs action';
}

function dependency(id: string, ownerId: string, byId: ReadonlyMap<string, Task>, cyclic: ReadonlySet<string>): { title: string; state: DependencyState } {
  const found = byId.get(id);
  if (!found) return { title: `Unknown task ${id}`, state: 'missing' };
  if (cyclic.has(ownerId) && cyclic.has(id)) return { title: found.title, state: 'cycle' };
  if (found.status === 'accepted') return { title: found.title, state: 'satisfied' };
  if (found.status === 'failed' || found.status === 'cancelled') return { title: found.title, state: 'terminal' };
  return { title: found.title, state: 'waiting' };
}

function budgetProblem(mission: Mission, spend: Spend | undefined): string | undefined {
  if (!spend) return undefined;
  if (mission.budgetSec !== undefined && !Number.isFinite(spend.elapsedSec)) return 'Repair the unreadable mission spend';
  if (mission.budgetTokens !== undefined && (spend.tokens === null || !Number.isFinite(spend.tokens))) return 'Repair the unreadable mission spend';
  if (mission.budgetSec !== undefined && spend.elapsedSec >= mission.budgetSec) return 'Raise or clear the elapsed-time budget';
  if (mission.budgetTokens !== undefined && spend.tokens !== null && spend.tokens >= mission.budgetTokens) return 'Raise or clear the token budget';
  return undefined;
}

function tasksInCycles(tasks: readonly Task[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) { for (const member of path.slice(path.indexOf(id))) cyclic.add(member); return; }
    if (visited.has(id)) return;
    visiting.add(id); path.push(id);
    for (const dependencyId of byId.get(id)?.dependsOn ?? []) if (byId.has(dependencyId)) visit(dependencyId);
    path.pop(); visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return cyclic;
}
