import { renderToStaticMarkup } from 'react-dom/server';
import type { Escalation, FleetLimits, Mission, MissionSpendLike, Task, TaskStatus } from '@claudia/shared';
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
const flow = (tasks: Task[], over: Partial<Mission> = {}, spend?: MissionSpendLike) =>
  missionFlow(tasks, { ...mission, ...over }, spend, limits, []);
const escalation = (over: Partial<Escalation>): Escalation => ({
  id: 'e1', missionId: 'm1', source: 'system', request: 'Bash', reason: 'needs approval',
  severity: 'blocking', resolution: 'pending', createdAt: 1, ...over,
});

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
    expect(model.next).toBe('A dependency that no longer exists blocks “Task 3”');
  });

  it('puts a paused mission before review or dispatch advice', () => {
    expect(flow([task('1', 'reported')], { watch: 'paused' }).next).toBe('Start watching to continue this mission');
  });

  it('does not promise dispatch after the mission spent its budget', () => {
    expect(flow([task('1', 'ready')], { budgetTokens: 100 }, { elapsedSec: 10, tokens: 100 }).next).toBe('Raise or clear the token budget');
  });

  it('identifies elapsed budget exhaustion without parsing its explanation', () => {
    expect(flow([task('1', 'ready')], { budgetSec: 60 }, { elapsedSec: 60, tokens: 10 }).next).toBe('Raise or clear the elapsed-time budget');
  });

  it('puts a pending escalation ahead of task advice', () => {
    expect(missionFlow([task('1', 'reported')], mission, undefined, limits, [escalation({})]).next)
      .toBe('Resolve “Bash” in the decision inbox');
  });

  it('does not call an attempts-blocked task done', () => {
    expect(flow([task('1', 'blocked')]).next).toBe('Inspect “Task 1”; its attempts may be exhausted');
  });

  it('calls cancelled dependencies terminal rather than finishable', () => {
    expect(flow([task('1', 'cancelled'), task('2', 'blocked', ['1'])]).next).toBe('A cancelled or failed dependency blocks “Task 2”');
  });

  it('identifies dependency cycles as repair work', () => {
    expect(flow([task('1', 'blocked', ['2']), task('2', 'blocked', ['1'])]).next).toBe('A dependency cycle blocks “Task 1”');
  });

  it('tells the human to approve a dependency only they can move', () => {
    // 'waiting' would be advice to wait for themselves: nothing but a person
    // moves a proposed task.
    const model = flow([task('1', 'proposed'), task('2', 'blocked', ['1'])]);
    expect(model.tasks.find((item) => item.id === '2')?.dependencies).toEqual([{ title: 'Task 1', state: 'unapproved' }]);
    expect(model.next).toBe('Approve or cancel Task 1 before “Task 2”');
  });

  it('does not promise a pulse the reconciler will refuse for an unreadable attempt limit', () => {
    expect(missionFlow([task('1', 'ready')], mission, undefined, { maxChildren: 12, maxAttempts: Number.NaN }, []).next)
      .toBe('Repair the unreadable attempt limit');
  });

  it('does not call a ceiling of zero a wait for capacity', () => {
    // Readable, legitimate and permanent: the reconciler holds "0 of 0 children
    // busy" on every pulse, so no pulse is coming to clear it.
    expect(flow([task('1', 'ready')], { maxChildren: 0 }).next).toBe('Raise the child limit; this mission may run none');
  });

  it('repairs rather than waits on an unreadable child limit', () => {
    expect(flow([task('1', 'ready')], { maxChildren: Number.NaN }).next).toBe('Repair the unreadable child limit');
  });

  it('stops offering an escalation the fleet has stopped offering', () => {
    const model = missionFlow([task('1', 'reported')], mission, undefined, limits, [escalation({ expiresAt: 500 })], 900);
    expect(model.next).toBe('Review “Task 1”');
  });

  it('keeps an unexpired escalation ahead of task advice', () => {
    const model = missionFlow([task('1', 'reported')], mission, undefined, limits, [escalation({ expiresAt: 1_000 })], 900);
    expect(model.next).toBe('Resolve “Bash” in the decision inbox');
  });

  it('does not send a person to answer an escalation on an archived mission', () => {
    // The reconciler holds on `mission is archived` and never acts on the
    // answer, so the escalation is the one action that changes nothing.
    const model = missionFlow([task('1', 'reported')], { ...mission, status: 'archived' }, undefined, limits, [escalation({})], 900);
    expect(model.next).toBe('Mission is archived');
  });

  it('breaks ties by id so one mission draws itself one way', () => {
    // Equal priority AND equal createdAt is the only input the third sort key
    // ever sees; without it the order is whatever the store happened to return.
    const tied = ['b', 'a', 'c'].map((id) => task(id, 'ready'));
    expect(flow(tied).tasks.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(flow([...tied].reverse()).tasks.map((item) => item.id)).toEqual(['a', 'b', 'c']);
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

  it('still advises a mission that has no tasks yet', () => {
    // The case a brand-new mission is in, and the one where "start watching" is
    // the most useful sentence in the app.
    const html = renderToStaticMarkup(<MissionFlow tasks={[]} mission={{ ...mission, watch: 'paused' }} limits={limits} spend={undefined} escalations={[]} />);
    expect(html).toContain('Start watching to continue this mission');
    expect(html).not.toContain('Task dependency flow');
    expect(html).not.toContain('Task status totals');
  });

  it('summarises terminal work instead of duplicating its cards', () => {
    const html = renderToStaticMarkup(<MissionFlow tasks={[task('1', 'accepted'), task('2', 'ready')]} mission={mission} limits={limits} spend={undefined} escalations={[]} />);
    expect(html).toContain('1 accepted or cancelled task');
    expect(html.match(/Task 1/g)).toBeNull();
    expect(html).toContain('Task 2');
  });
});
