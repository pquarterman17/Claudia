import { budgetHold, childCeiling, dependencyState, tasksInCycles, type DependencyState, type Escalation, type FleetLimits, type Mission, type MissionSpendLike, type Task, type TaskStatus } from '@claudia/shared';

export interface FlowTask { id: string; title: string; status: TaskStatus; dependencies: { title: string; state: DependencyState }[]; }
export interface MissionFlowModel { tasks: FlowTask[]; counts: Map<TaskStatus, number>; next: string; }

const STATUS_ORDER: readonly TaskStatus[] = ['reported', 'failed', 'blocked', 'running', 'ready', 'proposed', 'accepted', 'cancelled'];

/** A compact overview. Predictions use the same durable inputs as the reconciler. */
export function missionFlow(tasks: readonly Task[], mission: Mission, spend: MissionSpendLike | undefined, limits: FleetLimits, escalations: readonly Escalation[], now = Date.now()): MissionFlowModel {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cyclic = tasksInCycles(tasks);
  const unorderedCounts = new Map<TaskStatus, number>();
  for (const task of tasks) unorderedCounts.set(task.status, (unorderedCounts.get(task.status) ?? 0) + 1);
  const counts = new Map(STATUS_ORDER.flatMap((status) => {
    const count = unorderedCounts.get(status);
    return count === undefined ? [] : [[status, count] as const];
  }));
  const flowTasks = [...tasks]
    // The id tie-break is the reconciler's, for the reconciler's reason: without
    // it two tasks of equal priority and equal `createdAt` fall back to the
    // order the store happened to return, so the same mission draws itself
    // differently on two renders. Determinism is the property this view claims.
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.priority - b.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    .map((task) => ({ id: task.id, title: task.title, status: task.status, dependencies: task.dependsOn.map((id) => ({ title: byId.get(id)?.title ?? `Unknown task ${id}`, state: dependencyState(task, id, byId, cyclic) })) }));
  return { tasks: flowTasks, counts, next: nextAction(flowTasks, mission, spend, limits, escalations, now) };
}

function nextAction(tasks: readonly FlowTask[], mission: Mission, spend: MissionSpendLike | undefined, limits: FleetLimits, escalations: readonly Escalation[], now: number): string {
  if (mission.status !== 'active') return `Mission is ${mission.status}`;
  if (mission.watch !== 'watching') return 'Start watching to continue this mission';
  // An expired request is one the fleet has stopped offering, so offering it
  // here as the single most important action would outrank every other line in
  // the overview on the strength of a question nobody is being asked any more.
  const escalation = escalations.find((item) => item.resolution === 'pending' && (item.expiresAt === undefined || !(item.expiresAt <= now)));
  if (escalation) return `Resolve “${escalation.request}” in the decision inbox`;
  const budget = budgetHold(mission, spend);
  if (budget) {
    if (budget.kind === 'tokens') return 'Raise or clear the token budget';
    if (budget.kind === 'elapsed') return 'Raise or clear the elapsed-time budget';
    return 'Repair the unreadable mission spend';
  }
  const ceiling = childCeiling(mission, limits);
  if (ceiling === undefined) return 'Repair the unreadable child limit';
  // The reconciler's other unreadable limit, and the one this file first
  // forgot: an unreadable attempt ceiling makes it hold before it decides
  // anything at all, so promising a next pulse below would be a promise about
  // a pulse that returns one hold and no work.
  if (!Number.isSafeInteger(limits.maxAttempts) || limits.maxAttempts < 1) return 'Repair the unreadable attempt limit';
  const reported = tasks.find((task) => task.status === 'reported');
  if (reported) return `Review “${reported.title}”`;
  const failed = tasks.find((task) => task.status === 'failed');
  if (failed) return `Decide how to recover “${failed.title}”`;
  const blocked = tasks.find((task) => task.status === 'blocked');
  if (blocked) {
    const broken = blocked.dependencies.find((item): item is { title: string; state: keyof typeof PROBLEM } => item.state in PROBLEM);
    if (broken) return `${PROBLEM[broken.state]} blocks “${blocked.title}”`;
    // Before the waiting arm: an unapproved dependency looks like patience and
    // is not. Nothing moves it but the person reading this line.
    const unapproved = blocked.dependencies.filter((item) => item.state === 'unapproved');
    if (unapproved.length > 0) return `Approve or cancel ${titles(unapproved)} before “${blocked.title}”`;
    const waiting = blocked.dependencies.filter((item) => item.state === 'waiting');
    if (waiting.length > 0) return `Wait for ${titles(waiting)} before “${blocked.title}”`;
    return `Inspect “${blocked.title}”; its attempts may be exhausted`;
  }
  const proposed = tasks.find((task) => task.status === 'proposed');
  if (proposed) return `Approve or cancel “${proposed.title}”`;
  if (tasks.some((task) => task.status === 'running')) return 'Children are working; watch for a claim or escalation';
  // A ceiling of zero is readable, legitimate and permanent: the reconciler
  // holds with "0 of 0 children busy" every pulse. Naming the next pulse there
  // would promise work that no pulse can do.
  if (tasks.some((task) => task.status === 'ready')) {
    return ceiling === 0 ? 'Raise the child limit; this mission may run none' : 'Ready work is waiting for capacity or the next pulse';
  }
  return 'No task needs action';
}

function titles(dependencies: readonly { title: string }[]): string {
  return dependencies.map((item) => item.title).join(', ');
}

/** The dependency states a person has to repair, and no others: a lookup rather
 * than a chain of ifs so a new state cannot fall through to the wrong sentence. */
const PROBLEM = {
  cycle: 'A dependency cycle',
  missing: 'A dependency that no longer exists',
  terminal: 'A cancelled or failed dependency',
} as const;
