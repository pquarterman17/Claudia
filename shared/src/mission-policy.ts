import type { FleetLimits, Mission, Task } from './mission.js';

/** Spend as persisted by the server or represented on the wire (`null` means unreadable). */
export interface MissionSpendLike { elapsedSec: number; tokens: number | null; }

/**
 * How many children this mission may have running at once, or `undefined` when
 * that cannot be read.
 *
 * Shared because the reconciler is not the only caller. Found in review: the
 * watchdog's retry path reserves and launches directly, so it bypassed the
 * reconciler's gate entirely — a mission at a ceiling of zero still got a
 * replacement child, and lowering the ceiling under an over-cap fleet never
 * drained. A limit enforced in one of two places that spend is not a limit.
 *
 * The LOWER of the mission and fleet-wide policy applies. A whole non-negative
 * number or nothing: `Math.min(NaN, 2)` is NaN, and fractional or negative
 * ceilings produce nonsense precisely where a person asks why work stopped.
 */
export function childCeiling(mission: Mission, policy: FleetLimits): number | undefined {
  const ceiling = Math.min(mission.maxChildren, policy.maxChildren);
  return Number.isSafeInteger(ceiling) && ceiling >= 0 ? ceiling : undefined;
}

export type BudgetHold =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'elapsed'; reason: string }
  | { kind: 'tokens'; reason: string };

/**
 * Whether the mission has spent what it was given.
 *
 * These ceilings were once persisted and never read — the worst shape for a
 * limit: visible in the UI, settable by a human, and enforcing nothing. A
 * budget nobody checks is a promise the app is quietly breaking.
 *
 * A spend nobody could measure is not inside the budget. `NaN >= x` is false,
 * so one unusable model-usage number once switched the token ceiling off
 * silently. The discriminant is separate from the explanation so clients can
 * choose an action without parsing prose that may be reworded.
 */
export function budgetHold(mission: Mission, spend: MissionSpendLike | undefined): BudgetHold | undefined {
  if (!spend) return undefined;
  const unreadable = [
    mission.budgetSec !== undefined && !Number.isFinite(spend.elapsedSec) ? 'elapsed time' : undefined,
    mission.budgetTokens !== undefined && (spend.tokens === null || !Number.isFinite(spend.tokens)) ? 'token spend' : undefined,
  ].filter((what): what is string => what !== undefined);
  if (unreadable.length > 0) return { kind: 'unreadable', reason: `cannot read its ${unreadable.join(' or ')}` };
  if (mission.budgetSec !== undefined && spend.elapsedSec >= mission.budgetSec) return { kind: 'elapsed', reason: `spent its ${mission.budgetSec}s budget` };
  if (mission.budgetTokens !== undefined && spend.tokens !== null && spend.tokens >= mission.budgetTokens) return { kind: 'tokens', reason: `spent its ${mission.budgetTokens}-token budget` };
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

/**
 * Why one dependency does or does not let its dependent start.
 *
 * The fourth rule to move here, and the one that had drifted furthest: the
 * reconciler classified dependencies to pick a block reason while the overview
 * classified them again to draw an arrow, in different packages, in the same
 * order. Adding a `TaskStatus` updated one of them.
 *
 * `unapproved` is separate from `waiting` because they ask opposite things of
 * the person reading. A running dependency clears itself; a `proposed` one
 * clears only when a human approves or cancels it, so telling them to wait for
 * it is telling them to wait for themselves.
 */
export type DependencyState = 'satisfied' | 'waiting' | 'unapproved' | 'terminal' | 'missing' | 'cycle';

export function dependencyState(owner: Task, dependencyId: string, byId: ReadonlyMap<string, Task>, cyclic: ReadonlySet<string>): DependencyState {
  const dependency = byId.get(dependencyId);
  if (dependency === undefined) return 'missing';
  if (cyclic.has(owner.id) && cyclic.has(dependencyId)) return 'cycle';
  if (dependency.status === 'accepted') return 'satisfied';
  if (dependency.status === 'failed' || dependency.status === 'cancelled') return 'terminal';
  if (dependency.status === 'proposed') return 'unapproved';
  return 'waiting';
}
