import type { ChildRun, Task } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { describeRecovery, planRecovery, recoverRuns, recoverTasks } from '../src/fleet/recovery.js';

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

  it('orphans a run whose session is gone, and says to terminalize it', () => {
    // Found in review. An orphan that leaves the row saying `running` is worse
    // than no recovery: the reconciler counts it as an occupied slot forever,
    // so the task is reset to ready and then never dispatched.
    const recovered = recoverRuns([run({ id: 'r1', sessionId: 's1' })], new Set());
    expect(recovered[0]).toMatchObject({ kind: 'orphan', runId: 'r1', to: 'failed' });
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
        // Via `failed`, because that attempt did fail. The state machine also
        // allows `running -> reported -> ready`, which would assert a child
        // claimed the work was finished — legal and untrue.
        path: ['failed', 'ready'],
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
    expect(describeRecovery([], [])).toBe('recovered 0 run(s), orphaned 0, moved 0 task(s)');
  });

  it('counts each kind', () => {
    const summary = describeRecovery(
      [
        { kind: 'adopt', runId: 'a', sessionId: 's', reason: '' },
        { kind: 'orphan', runId: 'b', to: 'failed', reason: '' },
        { kind: 'leave', runId: 'c' },
      ],
      [{ taskId: 't', to: 'ready', path: ['failed', 'ready'], reason: '' }],
    );
    expect(summary).toBe('recovered 1 run(s), orphaned 1, moved 1 task(s): 1 to ready');
  });

  it('names where the tasks actually went, not where most of them went', () => {
    // Found in review: it always said "reset to ready", which describes the
    // opposite of what happened to a task restored to reported — in the one
    // line a human reads to find out what a restart did.
    const summary = describeRecovery(
      [],
      [
        { taskId: 'a', to: 'ready', path: ['failed', 'ready'], reason: '' },
        { taskId: 'b', to: 'reported', path: ['reported'], reason: '' },
        { taskId: 'c', to: 'ready', path: ['failed', 'ready'], reason: '' },
      ],
    );
    expect(summary).toContain('2 to ready');
    expect(summary).toContain('1 to reported');
  });
});

describe('planRecovery', () => {
  it('never resets a task without also terminalizing the run holding its slot', () => {
    // The wedge, end to end: task back to ready, run row still "running", the
    // reconciler skipping the task while counting its slot as busy.
    const plan = planRecovery([task({ id: 't1' })], [run({ id: 'r1', taskId: 't1' })], new Set());
    expect(plan.tasks).toEqual([
      {
        taskId: 't1',
        to: 'ready',
        path: ['failed', 'ready'],
        reason: 'it was running when the server stopped, and nothing is running now',
      },
    ]);
    expect(plan.runs).toEqual([
      { kind: 'orphan', runId: 'r1', to: 'failed', reason: 'its session did not survive the restart' },
    ]);
  });

  it('leaves both alone when the session survived', () => {
    const plan = planRecovery([task({ id: 't1' })], [run({ id: 'r1', taskId: 't1' })], new Set(['s1']));
    expect(plan.tasks).toEqual([]);
    expect(plan.runs[0]?.kind).toBe('adopt');
  });

  it('decides from the LATEST attempt, not a stale reported one', () => {
    // Found in review. Attempt 1 reported and was rejected; attempt 2 was
    // running at the crash. Taking "any run reported" restored a claim that
    // had already been considered and turned down.
    const plan = planRecovery(
      [task({ id: 't1' })],
      [
        run({ id: 'r1', taskId: 't1', attempt: 1, state: 'reported' }),
        run({ id: 'r2', taskId: 't1', attempt: 2, state: 'running' }),
      ],
      new Set(),
    );
    expect(plan.tasks[0]).toMatchObject({ taskId: 't1', to: 'ready' });
  });

  it('restores to reported when the latest attempt is the reported one', () => {
    const plan = planRecovery(
      [task({ id: 't1' })],
      [
        run({ id: 'r1', taskId: 't1', attempt: 1, state: 'failed' }),
        run({ id: 'r2', taskId: 't1', attempt: 2, state: 'reported' }),
      ],
      new Set(),
    );
    expect(plan.tasks[0]).toMatchObject({ taskId: 't1', to: 'reported' });
  });

  it('sends a task whose run already reported to review, not back to the queue', () => {
    // Found in review. That run did real work and its evidence is in the
    // worktree; re-dispatching throws it away and pays for it twice.
    const plan = planRecovery(
      [task({ id: 't1' })],
      [run({ id: 'r1', taskId: 't1', state: 'reported' })],
      new Set(),
    );
    expect(plan.tasks[0]).toMatchObject({ taskId: 't1', to: 'reported' });
    // And a reported run is terminal already, so nothing is written to it.
    expect(plan.runs).toEqual([{ kind: 'leave', runId: 'r1' }]);
  });

  it('leaves the task alone when the latest attempt is still alive', () => {
    // Attempts are unique per task in the store, so the later one is the one
    // that matters — here it survived the restart and is still working.
    const plan = planRecovery(
      [task({ id: 't1' })],
      [
        run({ id: 'r1', taskId: 't1', attempt: 1, state: 'reported' }),
        run({ id: 'r2', taskId: 't1', attempt: 2, sessionId: 's9' }),
      ],
      new Set(['s9']),
    );
    expect(plan.tasks).toEqual([]);
  });

  it('every orphaned run carries a terminal state', () => {
    // The property, not one example: nothing may be called orphaned and left
    // in a state the reconciler reads as active.
    const runs = [
      run({ id: 'a', state: 'running' }),
      run({ id: 'b', state: 'dispatched' }),
      run({ id: 'c', sessionId: 'gone' }),
    ];
    const plan = planRecovery([], runs, new Set());
    for (const decision of plan.runs) {
      if (decision.kind === 'orphan') expect(decision.to).toBe('failed');
    }
    expect(plan.runs.filter((r) => r.kind === 'orphan')).toHaveLength(3);
  });
});

describe('found by adversarial review', () => {
  it('never requeues a task that still has a live run, whatever the latest attempt did', () => {
    // Attempt 2 failed, attempt 1 is still alive and adopted. Requeueing here
    // dispatches a second agent into the same worktree as one already working.
    const plan = planRecovery(
      [task({ id: 't1' })],
      [
        run({ id: 'r1', taskId: 't1', attempt: 1, sessionId: 'alive', state: 'running' }),
        run({ id: 'r2', taskId: 't1', attempt: 2, sessionId: 'dead', state: 'failed' }),
      ],
      new Set(['alive']),
    );
    expect(plan.tasks).toEqual([]);
  });

  it('still requeues when every run for the task is gone', () => {
    const plan = planRecovery(
      [task({ id: 't1' })],
      [
        run({ id: 'r1', taskId: 't1', attempt: 1, sessionId: 'dead1', state: 'running' }),
        run({ id: 'r2', taskId: 't1', attempt: 2, sessionId: 'dead2', state: 'running' }),
      ],
      new Set(),
    );
    expect(plan.tasks[0]).toMatchObject({ to: 'ready', path: ['failed', 'ready'] });
  });
});
