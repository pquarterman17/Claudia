import type { Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { dependencyChoices, dependencyView } from '../src/task-dependencies';

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
    const tasks = [task('ready', 'ready'), task('done', 'accepted'), task('gone', 'cancelled')];
    expect(dependencyChoices(tasks).map((candidate) => candidate.id)).toEqual(['ready', 'done']);
  });

  it('resolves dependency names and statuses in stored order', () => {
    const tasks = [task('a', 'accepted'), task('b', 'running'), task('child', 'blocked', ['b', 'a'])];
    expect(dependencyView(tasks[2]!, tasks)).toEqual([
      { id: 'b', title: 'Task b', status: 'running', missing: false },
      { id: 'a', title: 'Task a', status: 'accepted', missing: false },
    ]);
  });

  it('shows a missing reference instead of silently hiding it', () => {
    const child = task('child', 'blocked', ['lost']);
    expect(dependencyView(child, [child])).toEqual([
      { id: 'lost', title: 'Unknown task lost', missing: true },
    ]);
  });
});
