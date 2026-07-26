import type { SessionSummary } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { orderSessions } from '../src/session-order';

const session = (id: string, startedAt: number, state: SessionSummary['state']): SessionSummary =>
  ({
    id,
    name: id,
    cwd: `/${id}`,
    state,
    startedAt,
    lastActivityAt: startedAt,
    permissionMode: 'auto',
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }) as SessionSummary;

describe('orderSessions', () => {
  it('puts sessions needing attention ahead of working and idle sessions', () => {
    const idle = session('idle', 1, 'idle');
    const working = session('working', 2, 'working');
    const approval = {
      ...session('approval', 3, 'awaiting_approval'),
      pendingApproval: { requestId: 'r1', toolName: 'Bash', summary: 'Run tests', input: {} },
    } as SessionSummary;

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
