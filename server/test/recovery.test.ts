import type { ChildRun, Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { describeRecovery, recoverRuns, recoverTasks } from '../src/fleet/recovery.js';

/**
 * The post-crash states. A run row saying `running` is, after a restart, a
 * claim about a process that may not exist — and the two ways of being wrong
 * about it are a permanently occupied concurrency slot, or re-doing work that
 * already happened.
 */

function run(over: Partial<ChildRun> & { id: string }): ChildRun {
  return {
    missionId: 'm1',
    taskId: 't1',
    sessionId: 's1',
    agent: 'claude',
    attempt: 1,
    state: 'running',
    startedAt: 1,
    ...over,
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    missionId: 'm1',
    title: 'a task',
    description: '',
    cwd: '/repo',
    status: 'running',
    priority: 0,
    dependsOn: [],
    acceptance: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

describe('recoverRuns', () => {
  it('adopts a run whose session survived', () => {
    const recovered = recoverRuns([run({ id: 'r1', sessionId: 's1' })], new Set(['s1']));
    expect(recovered[0]).toMatchObject({ kind: 'adopt', runId: 'r1', sessionId: 's1' });
  });

  it('orphans a run whose session is gone', () => {
    const recovered = recoverRuns([run({ id: 'r1', sessionId: 's1' })], new Set());
    expect(recovered[0]).toMatchObject({ kind: 'orphan', runId: 'r1' });
    expect(recovered[0]?.kind === 'orphan' && recovered[0].reason).toContain('did not survive');
  });

  it('distinguishes a run that never had a session from one that lost it', () => {
    // A run with no session id crashed between dispatch and launch, which is
    // a different bug from one whose process died.
    const noSession = run({ id: 'r1' });
    delete noSession.sessionId;
    const recovered = recoverRuns([noSession], new Set());
    expect(recovered[0]?.kind === 'orphan' && recovered[0].reason).toContain('never recorded a session');
  });

  it.each(['stopped', 'failed', 'reported'] as const)('leaves a %s run alone', (state) => {
    expect(recoverRuns([run({ id: 'r1', state })], new Set())).toEqual([{ kind: 'leave', runId: 'r1' }]);
  });

  it('orphans a dispatched run that never got going', () => {
    const recovered = recoverRuns([run({ id: 'r1', state: 'dispatched' })], new Set());
    expect(recovered[0]?.kind).toBe('orphan');
  });

  it('decides for every run, so none is silently skipped', () => {
    const runs = [run({ id: 'a' }), run({ id: 'b', state: 'failed' }), run({ id: 'c', sessionId: 's9' })];
    expect(recoverRuns(runs, new Set(['s9'])).map((r) => r.runId)).toEqual(['a', 'b', 'c']);
  });
});

describe('recoverTasks', () => {
  it('sends a running task with no surviving run back to ready', () => {
    // The characteristic post-crash wedge: the reconciler skips it because it
    // is not ready, and the watchdog never sees it because nothing is running.
    const recovered = recoverTasks([task({ id: 't1' })], [run({ id: 'r1', taskId: 't1' })], new Set());
    expect(recovered).toEqual([
      {
        taskId: 't1',
        to: 'ready',
        reason: 'it was running when the server stopped, and nothing is running now',
      },
    ]);
  });

  it('leaves a running task alone when its run was adopted', () => {
    const recovered = recoverTasks([task({ id: 't1' })], [run({ id: 'r1', taskId: 't1' })], new Set(['r1']));
    expect(recovered).toEqual([]);
  });

  it.each(['proposed', 'ready', 'blocked', 'reported', 'accepted', 'failed', 'cancelled'] as const)(
    'does not touch a %s task',
    (status) => {
      expect(recoverTasks([task({ id: 't1', status })], [], new Set())).toEqual([]);
    },
  );

  it('leaves a reported task as a standing claim', () => {
    // A restart is not a reason to withdraw a claim awaiting a decision.
    expect(recoverTasks([task({ id: 't1', status: 'reported' })], [], new Set())).toEqual([]);
  });

  it('does not reset the attempt count, so a reset cannot loop forever', () => {
    // Recovery returns a status change only; the run rows that carry the
    // attempt count are untouched, which is what bounds the retry.
    const runs = [run({ id: 'r1', taskId: 't1', attempt: 3 })];
    const recovered = recoverTasks([task({ id: 't1' })], runs, new Set());
    expect(recovered).toHaveLength(1);
    expect(runs[0]?.attempt).toBe(3);
  });
});

describe('describeRecovery', () => {
  it('says something even when nothing needed recovering', () => {
    // "recovered 0" and "never ran recovery" are indistinguishable later
    // unless one of them writes a line.
    expect(describeRecovery([], [])).toBe('recovered 0 run(s), orphaned 0, reset 0 task(s) to ready');
  });

  it('counts each kind', () => {
    const summary = describeRecovery(
      [
        { kind: 'adopt', runId: 'a', sessionId: 's', reason: '' },
        { kind: 'orphan', runId: 'b', reason: '' },
        { kind: 'leave', runId: 'c' },
      ],
      [{ taskId: 't', to: 'ready', reason: '' }],
    );
    expect(summary).toBe('recovered 1 run(s), orphaned 1, reset 1 task(s) to ready');
  });
});
