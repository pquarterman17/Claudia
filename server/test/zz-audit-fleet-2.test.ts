import { describe, expect, it } from 'vitest';
import type { Mission, Task, ChildRun } from '@claudia/shared';
import { reconcile } from './zz-audit-fleet-head-reconcile.js';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 'm1', name: 'm', body: '', status: 'active', watch: 'watching',
    pulseSec: 60, maxChildren: 4, cwd: '/repo', createdAt: 1, updatedAt: 1, ...over,
  } as Mission;
}
function task(id: string): Task {
  return {
    id, missionId: 'm1', title: id, description: '', cwd: '/repo', status: 'ready',
    priority: 1, acceptance: '', dependsOn: [], createdAt: 1, updatedAt: 1,
  } as unknown as Task;
}
const POLICY = { maxChildren: 4, maxAttempts: 3 };

describe('E: the new ceiling with an unusable mission.maxChildren', () => {
  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['0', 0],
    ['-1', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['2.5', 2.5],
    ['normal 1', 1],
  ] as const)('maxChildren = %s', (label, value) => {
    const d = reconcile({
      mission: mission({ maxChildren: value as number }),
      tasks: [task('t1'), task('t2'), task('t3')],
      runs: [],
      policy: POLICY,
    });
    console.log(`[E] maxChildren=${label} -> ${d.length} decision(s): ${JSON.stringify(d)}`);
  });

  it('NaN ceiling with a blocked task that has just become dispatchable', () => {
    const blocked = { ...task('t1'), status: 'blocked' } as Task;
    const d = reconcile({
      mission: mission({ maxChildren: Number.NaN }),
      tasks: [blocked],
      runs: [],
      policy: POLICY,
    });
    console.log('[E2] NaN ceiling, blocked task ->', JSON.stringify(d));
    // The task is unblocked but never dispatched, and nothing says why.
    expect(d.some((x) => x.kind === 'unblock')).toBe(true);
    expect(d.some((x) => x.kind === 'dispatch')).toBe(false);
    expect(d.some((x) => x.kind === 'hold')).toBe(false);
  });

  it('NaN ceiling emits no decision at all, unlike overBudget which refuses', () => {
    const nanCeiling = reconcile({
      mission: mission({ maxChildren: Number.NaN }),
      tasks: [task('t1')], runs: [], policy: POLICY,
    });
    const nanSpend = reconcile({
      mission: mission({ budgetTokens: 100 }),
      tasks: [task('t1')], runs: [], policy: POLICY,
      spend: { elapsedSec: 0, tokens: Number.NaN },
    });
    console.log('[E3] NaN ceiling ->', JSON.stringify(nanCeiling));
    console.log('[E3] NaN spend    ->', JSON.stringify(nanSpend));
    expect(nanCeiling).toEqual([]);
    expect(nanSpend[0]).toMatchObject({ kind: 'hold' });
  });
});

describe('F: overBudget refusal', () => {
  const cases: Array<[string, Partial<Mission>, { elapsedSec: number; tokens: number } | undefined]> = [
    ['no budgets, NaN spend', {}, { elapsedSec: Number.NaN, tokens: Number.NaN }],
    ['tokens budget, NaN tokens', { budgetTokens: 100 }, { elapsedSec: 0, tokens: Number.NaN }],
    ['tokens budget, NaN elapsed only', { budgetTokens: 100 }, { elapsedSec: Number.NaN, tokens: 5 }],
    ['sec budget, NaN elapsed', { budgetSec: 100 }, { elapsedSec: Number.NaN, tokens: 0 }],
    ['both budgets, both NaN', { budgetSec: 100, budgetTokens: 100 }, { elapsedSec: Number.NaN, tokens: Number.NaN }],
    ['tokens budget, Infinity tokens', { budgetTokens: 100 }, { elapsedSec: 0, tokens: Number.POSITIVE_INFINITY }],
    ['tokens budget, -Infinity tokens', { budgetTokens: 100 }, { elapsedSec: 0, tokens: Number.NEGATIVE_INFINITY }],
    ['no spend at all', { budgetTokens: 100 }, undefined],
    ['spend undefined fields', { budgetTokens: 100 }, { elapsedSec: 0, tokens: undefined as unknown as number }],
  ];
  it.each(cases)('%s', (label, over, spend) => {
    const d = reconcile({ mission: mission(over), tasks: [task('t1')], runs: [], policy: POLICY, spend });
    const holds = d.filter((x) => x.kind === 'hold');
    console.log(`[F] ${label} -> ${d.map((x) => `${x.kind}(${'reason' in x ? x.reason : ''})`).join(' | ')}`);
    void holds;
  });
});

describe('G: does the ceiling actually enforce mission.maxChildren?', () => {
  it('mission 1, policy 8, three ready tasks', () => {
    const d = reconcile({
      mission: mission({ maxChildren: 1 }),
      tasks: [task('t1'), task('t2'), task('t3')],
      runs: [] as ChildRun[],
      policy: { maxChildren: 8, maxAttempts: 3 },
    });
    console.log('[G] ->', JSON.stringify(d));
    expect(d.filter((x) => x.kind === 'dispatch')).toHaveLength(1);
  });
});
