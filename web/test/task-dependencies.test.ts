import { dependencyState, TASK_TRANSITIONS, tasksInCycles, type Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { availableDependencyIds, dependencyChoices, dependencyView, retainedDependencies } from '../src/task-dependencies';

function task(id: string, status: Task['status'], dependsOn: string[] = []): Task {
  return {
    id,
    missionId: 'mission',
    title: `Task ${id}`,
    description: '',
    cwd: '/repo',
    status,
    priority: 0,
    dependsOn,
    acceptance: '',
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('mission task dependency presentation', () => {
  it('does not offer failed or cancelled work that can never satisfy a dependency', () => {
    const tasks = [task('ready', 'ready'), task('done', 'accepted'), task('failed', 'failed'), task('gone', 'cancelled')];
    expect(dependencyChoices(tasks).map((candidate) => candidate.id)).toEqual(['done', 'ready']);
  });

  it('resolves dependency names and states in stored order', () => {
    const tasks = [task('a', 'accepted'), task('b', 'running'), task('child', 'blocked', ['b', 'a'])];
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    expect(dependencyView(tasks[2]!, byId, tasksInCycles(tasks))).toEqual([
      { id: 'b', title: 'Task b', state: 'waiting' },
      { id: 'a', title: 'Task a', state: 'satisfied' },
    ]);
  });

  it('shows a missing reference instead of silently hiding it', () => {
    const child = task('child', 'blocked', ['lost']);
    expect(dependencyView(child, new Map([[child.id, child]]), tasksInCycles([child]))).toEqual([
      { id: 'lost', title: 'Unknown task lost', state: 'missing' },
    ]);
  });

  it('labels a dependency cycle instead of presenting it as ordinary waiting', () => {
    const a = task('a', 'blocked', ['b']);
    const b = task('b', 'blocked', ['a']);
    const tasks = [a, b];
    expect(dependencyView(a, new Map(tasks.map((candidate) => [candidate.id, candidate])), tasksInCycles(tasks))[0]?.state)
      .toBe('cycle');
  });

  it('keeps the same selection object when every dependency remains available', () => {
    const selected = ['a', 'b'];
    expect(retainedDependencies(selected, new Set(selected))).toBe(selected);
    expect(retainedDependencies(selected, new Set(['b']))).toEqual(['b']);
  });

  it('refuses exactly the statuses the shared policy calls terminal', () => {
    const all = (Object.keys(TASK_TRANSITIONS) as Task['status'][]).map((status) => task(status, status));
    const offered = new Set(dependencyChoices(all).map((candidate) => candidate.id));
    const byId = new Map(all.map((candidate) => [candidate.id, candidate]));
    const owner = task('owner', 'proposed', all.map((candidate) => candidate.id));
    for (const candidate of all) {
      const terminal = dependencyState(owner, candidate.id, byId, new Set()) === 'terminal';
      expect(offered.has(candidate.id)).toBe(!terminal);
    }
  });

  it('offers exactly the dependency ids the prune keeps', () => {
    const all = (Object.keys(TASK_TRANSITIONS) as Task['status'][]).map((status) => task(status, status));
    expect(availableDependencyIds(all)).toEqual(new Set(dependencyChoices(all).map((candidate) => candidate.id)));
  });
});
