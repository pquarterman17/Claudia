import { renderToStaticMarkup } from 'react-dom/server';
import type { Task, TaskStatus } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { MissionFlow } from '../src/components/MissionFlow';
import { missionFlow } from '../src/mission-flow';

function task(id: string, status: TaskStatus, dependsOn: string[] = [], priority = 0): Task {
  return {
    id,
    missionId: 'm1',
    title: `Task ${id}`,
    description: '',
    cwd: '/repo',
    status,
    priority,
    dependsOn,
    acceptance: '',
    createdAt: Number(id.replace(/\D/g, '')) || 1,
    updatedAt: 1,
  };
}

describe('mission flow model', () => {
  it('puts a completion claim first and names it as the next decision', () => {
    const model = missionFlow([task('1', 'running'), task('2', 'reported')], 'watching');
    expect(model.tasks.map((item) => item.id)).toEqual(['2', '1']);
    expect(model.next).toBe('Review “Task 2”');
  });

  it('explains the dependency holding blocked work', () => {
    const model = missionFlow([task('1', 'running'), task('2', 'blocked', ['1'])], 'watching');
    expect(model.tasks.find((item) => item.id === '2')?.unresolvedDependencies).toEqual(['Task 1']);
    expect(model.next).toBe('Unblock “Task 2” by finishing Task 1');
  });

  it('distinguishes accepted, missing, and unresolved dependencies', () => {
    const model = missionFlow([
      task('1', 'accepted'), task('2', 'ready'), task('3', 'blocked', ['1', '2', 'missing']),
    ], 'watching');
    const blocked = model.tasks.find((item) => item.id === '3');
    expect(blocked?.dependencyTitles).toEqual(['Task 1', 'Task 2', 'Unknown task missing']);
    expect(blocked?.unresolvedDependencies).toEqual(['Task 2', 'Unknown task missing']);
  });

  it('says when paused ready work cannot dispatch', () => {
    expect(missionFlow([task('1', 'ready')], 'paused').next).toBe('Start watching to dispatch ready work');
  });

  it('orders a dense 16-task fixture deterministically', () => {
    const tasks = Array.from({ length: 16 }, (_, index) => task(String(index + 1), index % 2 ? 'ready' : 'accepted', [], 15 - index));
    const first = missionFlow(tasks, 'watching').tasks.map((item) => item.id);
    expect(missionFlow([...tasks].reverse(), 'watching').tasks.map((item) => item.id)).toEqual(first);
    expect(first).toHaveLength(16);
  });
});

describe('mission flow view', () => {
  it('renders status text, next action, and an accessible dependency label', () => {
    const html = renderToStaticMarkup(<MissionFlow tasks={[task('1', 'running'), task('2', 'blocked', ['1'])]} watch="watching" />);
    expect(html).toContain('Task status totals');
    expect(html).toContain('Task dependency flow');
    expect(html).toContain('Depends on');
    expect(html).toContain('Unblock');
    expect(html).toContain('Blocked');
  });

  it('renders nothing while there are no loaded tasks', () => {
    expect(renderToStaticMarkup(<MissionFlow tasks={undefined} watch="paused" />)).toBe('');
  });
});
