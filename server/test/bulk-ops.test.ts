import type { SessionSummary } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { runBulkOp } from '../src/bulk-ops.js';

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'a',
    name: 'x',
    cwd: '/x',
    permissionMode: 'default',
    state: 'working',
    startedAt: 0,
    lastActivityAt: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    queuedPrompts: [],
    ...over,
  } as SessionSummary;
}

/** A SessionManager fake exposing only what runBulkOp reads. */
function fakeManager(summaries: SessionSummary[], sessions: Record<string, { approve: (id: string) => void; interrupt: () => void }>) {
  return {
    summaries: () => summaries,
    get: (id: string) => sessions[id],
  };
}

describe('runBulkOp', () => {
  it('approves every pending approval, skipping ones with an open question', () => {
    const approveA = vi.fn();
    const approveB = vi.fn();
    const summaries = [
      summary({ id: 'a', pendingApproval: { requestId: 'req-a', toolName: 'Bash', summary: 'ls', requestedAt: 0 } }),
      // A question is answered, not approved — "approving" it would resolve
      // it with no answer at all.
      summary({
        id: 'b',
        pendingApproval: { requestId: 'req-b', toolName: 'Bash', summary: 'ls', requestedAt: 0 },
        pendingQuestion: { requestId: 'q-b', questions: [], requestedAt: 0 },
      }),
    ];
    const manager = fakeManager(summaries, {
      a: { approve: approveA, interrupt: vi.fn() },
      b: { approve: approveB, interrupt: vi.fn() },
    });

    runBulkOp(manager as never, 'approve_all');

    expect(approveA).toHaveBeenCalledWith('req-a');
    expect(approveB).not.toHaveBeenCalled();
  });

  it('interrupts every working or starting session, leaving idle ones alone', () => {
    const interruptA = vi.fn();
    const interruptB = vi.fn();
    const summaries = [summary({ id: 'a', state: 'working' }), summary({ id: 'b', state: 'idle' })];
    const manager = fakeManager(summaries, {
      a: { approve: vi.fn(), interrupt: interruptA },
      b: { approve: vi.fn(), interrupt: interruptB },
    });

    runBulkOp(manager as never, 'interrupt_all');

    expect(interruptA).toHaveBeenCalled();
    expect(interruptB).not.toHaveBeenCalled();
  });

  it('skips a summary id the manager no longer has a live session for', () => {
    const summaries = [summary({ id: 'gone' })];
    const manager = fakeManager(summaries, {});
    expect(() => runBulkOp(manager as never, 'approve_all')).not.toThrow();
  });
});
