import type { FleetLimits, Mission, Task } from './mission.js';

/** Spend as persisted by the server or represented on the wire (`null` means unreadable). */
export interface MissionSpendLike { elapsedSec: number; tokens: number | null; }

/** The lower of the mission and fleet child ceilings, when it is readable. */
export function childCeiling(mission: Mission, policy: FleetLimits): number | undefined {
  const ceiling = Math.min(mission.maxChildren, policy.maxChildren);
  return Number.isSafeInteger(ceiling) && ceiling >= 0 ? ceiling : undefined;
}

/** The reconciler's mission-level budget hold, shared with advisory clients. */
export function budgetHold(mission: Mission, spend: MissionSpendLike | undefined): string | undefined {
  if (!spend) return undefined;
  const unreadable = [
    mission.budgetSec !== undefined && !Number.isFinite(spend.elapsedSec) ? 'elapsed time' : undefined,
    mission.budgetTokens !== undefined && (spend.tokens === null || !Number.isFinite(spend.tokens)) ? 'token spend' : undefined,
  ].filter((what): what is string => what !== undefined);
  if (unreadable.length > 0) return `cannot read its ${unreadable.join(' or ')}`;
  if (mission.budgetSec !== undefined && spend.elapsedSec >= mission.budgetSec) return `spent its ${mission.budgetSec}s budget`;
  if (mission.budgetTokens !== undefined && spend.tokens !== null && spend.tokens >= mission.budgetTokens) return `spent its ${mission.budgetTokens}-token budget`;
  return undefined;
}

/** Tasks that can never start because their dependency graph loops. */
export function tasksInCycles(tasks: readonly Task[]): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const cyclic = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      for (const member of path.slice(path.indexOf(id))) cyclic.add(member);
      return;
    }
    state.set(id, 'visiting');
    path.push(id);
    for (const dependencyId of byId.get(id)?.dependsOn ?? []) if (byId.has(dependencyId)) visit(dependencyId);
    path.pop();
    state.set(id, 'done');
  };
  for (const task of tasks) visit(task.id);
  return cyclic;
}
