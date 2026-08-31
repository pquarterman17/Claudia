import type { SessionSummary } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { orderSessions } from '../src/session-order';

// No cast: the point of typechecking the tests is that a fixture which is not
// a SessionSummary says so here rather than passing and pinning a shape the app
// never sees.
const session = (id: string, startedAt: number, state: SessionSummary['state']): SessionSummary =>
  ({
    id,
    name: id,
    cwd: `/${id}`,
    state,
    startedAt,
    lastActivityAt: startedAt,
    permissionMode: 'auto',
    effortLevel: 'medium',
    thinkingMode: 'adaptive',
    contextPending: false,
    todos: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    queuedPrompts: [],
  });

describe('orderSessions', () => {
  it('puts sessions needing attention ahead of working and idle sessions', () => {
    const idle = session('idle', 1, 'idle');
    const working = session('working', 2, 'working');
    const approval = {
      ...session('approval', 3, 'awaiting_approval'),
      pendingApproval: { requestId: 'r1', toolName: 'Bash', summary: 'Run tests', input: {}, requestedAt: 0 },
    };

    expect(orderSessions([idle, working, approval], true).map((item) => item.id)).toEqual([
      'approval',
      'working',
      'idle',
    ]);
  });

  it('preserves chronological order when attention sorting is off', () => {
    const newerError = session('error', 3, 'error');
    const olderIdle = session('idle', 1, 'idle');
    expect(orderSessions([newerError, olderIdle], false).map((item) => item.id)).toEqual([
      'idle',
      'error',
    ]);
  });
});
