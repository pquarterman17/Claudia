import { describe, expect, it } from 'vitest';
import { SubAgentTracker } from '../src/sub-agent-tracker.js';

const progress = {
  taskId: 't1',
  agentType: 'general-purpose',
  description: 'Finding server/src/**/*.ts',
  lastTool: 'Glob',
  totalTokens: 42667,
  toolUses: 1,
  durationMs: 1939,
  status: 'running' as const,
};

describe('SubAgentTracker', () => {
  it('records a running sub-agent under its step', () => {
    const t = new SubAgentTracker();
    const runs = t.merge('step-1', progress);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentType: 'general-purpose', totalTokens: 42667 });
  });

  it('updates the same task in place rather than duplicating it', () => {
    const t = new SubAgentTracker();
    t.merge('step-1', progress);
    const runs = t.merge('step-1', { ...progress, totalTokens: 58883, toolUses: 3 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.totalTokens).toBe(58883);
  });

  it('KEEPS usage when the completion notification arrives without it', () => {
    // The completion message carries status and a summary but no usage. A naive
    // overwrite would zero the token count at the exact moment it matters.
    const t = new SubAgentTracker();
    t.merge('step-1', progress);
    const runs = t.merge('step-1', { taskId: 't1', status: 'completed', summary: 'Total: 21' });
    expect(runs[0]).toMatchObject({
      status: 'completed',
      summary: 'Total: 21',
      totalTokens: 42667,
      agentType: 'general-purpose',
    });
  });

  it('keeps parallel sub-agents of one step separate', () => {
    const t = new SubAgentTracker();
    t.merge('step-1', progress);
    const runs = t.merge('step-1', { ...progress, taskId: 't2', description: 'other work' });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.taskId)).toEqual(['t1', 't2']);
  });

  it('keeps different steps independent', () => {
    const t = new SubAgentTracker();
    t.merge('step-1', progress);
    t.merge('step-2', { ...progress, taskId: 't2' });
    expect(t.get('step-1')).toHaveLength(1);
    expect(t.get('step-2')).toHaveLength(1);
  });

  it('fails running sub-agents when the session dies, leaving finished ones alone', () => {
    const t = new SubAgentTracker();
    t.merge('step-1', progress);
    t.merge('step-1', { taskId: 'done', status: 'completed' });

    const abandoned = t.abandon();
    expect(abandoned).toHaveLength(1);
    const runs = abandoned[0]?.runs ?? [];
    expect(runs.find((r) => r.taskId === 't1')?.status).toBe('error');
    expect(runs.find((r) => r.taskId === 'done')?.status).toBe('completed');
  });

  it('has nothing to abandon when everything already finished', () => {
    const t = new SubAgentTracker();
    t.merge('step-1', { taskId: 't1', status: 'completed' });
    expect(t.abandon()).toHaveLength(0);
  });

  it('returns an empty list for an unknown step', () => {
    expect(new SubAgentTracker().get('nope')).toEqual([]);
  });
});
