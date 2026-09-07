import { renderToStaticMarkup } from 'react-dom/server';
import type { FleetLimits, Mission, Task, TaskStatus } from '@claudia/shared';
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

const mission: Mission = { id: 'm1', name: 'Mission', body: '', status: 'active', watch: 'watching', pulseSec: 60, maxChildren: 4, cwd: '/repo', agent: 'claude', createdAt: 1, updatedAt: 1 };
const limits: FleetLimits = { maxChildren: 12, maxAttempts: 3 };
const flow = (tasks: Task[], over: Partial<Mission> = {}, spend?: { elapsedSec: number; tokens: number | null }) =>
  missionFlow(tasks, { ...mission, ...over }, spend, limits, []);

describe('mission flow model', () => {
  it('puts a completion claim first and names it as the next decision', () => {
    const model = flow([task('1', 'running'), task('2', 'reported')]);
    expect(model.tasks.map((item) => item.id)).toEqual(['2', '1']);
    expect(model.next).toBe('Review “Task 2”');
  });

  it('explains the dependency holding blocked work', () => {
    const model = flow([task('1', 'running'), task('2', 'blocked', ['1'])]);
    expect(model.tasks.find((item) => item.id === '2')?.dependencies).toEqual([{ title: 'Task 1', state: 'waiting' }]);
    expect(model.next).toBe('Wait for Task 1 before “Task 2”');
  });

  it('distinguishes accepted, missing, and unresolved dependencies', () => {
    const model = flow([
      task('1', 'accepted'), task('2', 'ready'), task('3', 'blocked', ['1', '2', 'missing']),
    ]);
    const blocked = model.tasks.find((item) => item.id === '3');
    expect(blocked?.dependencies).toEqual([
      { title: 'Task 1', state: 'satisfied' }, { title: 'Task 2', state: 'waiting' }, { title: 'Unknown task missing', state: 'missing' },
    ]);
    expect(model.next).toBe('Repair the missing dependency blocking “Task 3”');
  });

  it('puts a paused mission before review or dispatch advice', () => {
    expect(flow([task('1', 'reported')], { watch: 'paused' }).next).toBe('Start watching to continue this mission');
  });

  it('does not promise dispatch after the mission spent its budget', () => {
    expect(flow([task('1', 'ready')], { budgetTokens: 100 }, { elapsedSec: 10, tokens: 100 }).next).toBe('Raise or clear the token budget');
  });

  it('puts a pending escalation ahead of task advice', () => {
    const model = missionFlow([task('1', 'reported')], mission, undefined, limits, [{
      id: 'e1', missionId: 'm1', source: 'system', request: 'Bash', reason: 'needs approval',
      severity: 'blocking', resolution: 'pending', createdAt: 1,
    }]);
    expect(model.next).toBe('Resolve “Bash” in the decision inbox');
  });

  it('does not call an attempts-blocked task done', () => {
    expect(flow([task('1', 'blocked')]).next).toBe('Inspect “Task 1”; its attempts may be exhausted');
  });

  it('calls cancelled dependencies terminal rather than finishable', () => {
    expect(flow([task('1', 'cancelled'), task('2', 'blocked', ['1'])]).next).toBe('Repair the terminal dependency blocking “Task 2”');
  });

  it('identifies dependency cycles as repair work', () => {
    expect(flow([task('1', 'blocked', ['2']), task('2', 'blocked', ['1'])]).next).toBe('Repair the cycle dependency blocking “Task 1”');
  });

  it('orders a dense 16-task fixture deterministically', () => {
    const tasks = Array.from({ length: 16 }, (_, index) => task(String(index + 1), index % 2 ? 'ready' : 'accepted', [], 15 - index));
    const first = flow(tasks).tasks.map((item) => item.id);
    expect(flow([...tasks].reverse()).tasks.map((item) => item.id)).toEqual(first);
    expect(first).toHaveLength(16);
  });
});

describe('mission flow view', () => {
  it('renders status text, next action, and an accessible dependency label', () => {
    const html = renderToStaticMarkup(<MissionFlow tasks={[task('1', 'running'), task('2', 'blocked', ['1'])]} mission={mission} limits={limits} spend={undefined} escalations={[]} />);
    expect(html).toContain('Task status totals');
    expect(html).toContain('Task dependency flow');
    expect(html).toContain('Depends on');
    expect(html).toContain('Wait for');
    expect(html).toContain('Blocked');
  });

  it('renders nothing while there are no loaded tasks', () => {
    expect(renderToStaticMarkup(<MissionFlow tasks={undefined} mission={mission} limits={limits} spend={undefined} escalations={[]} />)).toBe('');
  });
});
