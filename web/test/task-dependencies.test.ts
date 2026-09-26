import type { Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { dependencyChoices, dependencyView, retainedDependencies } from '../src/task-dependencies';
import { tasksInCycles } from '@claudia/shared';

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
  it('does not offer cancelled work that can never satisfy a dependency', () => {
    const tasks = [task('ready', 'ready'), task('done', 'accepted'), task('failed', 'failed'), task('gone', 'cancelled')];
    expect(dependencyChoices(tasks).map((candidate) => candidate.id)).toEqual(['done', 'ready']);
  });

  it('resolves dependency names and statuses in stored order', () => {
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
});
