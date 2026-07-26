import type { SessionState, SessionSummary } from '@claudia/shared';
import { describe, expect, it } from 'vitest';
import { newlyNeedingAttention, stateMap, titleFor } from '../src/notifications';

function session(id: string, state: SessionState, extra: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    name: id,
    cwd: '/x',
    permissionMode: 'default',
    state,
    startedAt: 0,
    lastActivityAt: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    queuedPrompts: [],
    ...extra,
  };
}

const approval = { requestId: 'r1', toolName: 'Bash', summary: 'rm -rf build', requestedAt: 0 };

describe('newlyNeedingAttention', () => {
  it('fires when a session starts waiting on approval', () => {
    const events = newlyNeedingAttention(
      new Map([['a', 'working' as SessionState]]),
      [session('a', 'awaiting_approval', { pendingApproval: approval })],
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sessionId: 'a', kind: 'awaiting_approval' });
    expect(events[0]?.detail).toContain('rm -rf build');
  });

  it('does NOT fire again while it keeps waiting', () => {
    // Without the transition check, every update would re-notify for a session
    // that is simply still waiting — unusable within seconds.
    const current = [session('a', 'awaiting_approval', { pendingApproval: approval })];
    expect(newlyNeedingAttention(stateMap(current), current)).toHaveLength(0);
  });

  it('fires when a session errors, carrying the reason', () => {
    const events = newlyNeedingAttention(
      new Map([['a', 'working' as SessionState]]),
      [session('a', 'error', { errorMessage: 'process exited 1' })],
    );
    expect(events[0]).toMatchObject({ kind: 'error', detail: 'process exited 1' });
  });

  it('stays quiet for ordinary progress', () => {
    const previous = new Map<string, SessionState>([['a', 'starting']]);
    expect(newlyNeedingAttention(previous, [session('a', 'working')])).toHaveLength(0);
    expect(newlyNeedingAttention(previous, [session('a', 'idle')])).toHaveLength(0);
    expect(newlyNeedingAttention(previous, [session('a', 'stopped')])).toHaveLength(0);
  });

  it('fires for a session it has never seen before', () => {
    const events = newlyNeedingAttention(new Map(), [
      session('new', 'awaiting_approval', { pendingApproval: approval }),
    ]);
    expect(events).toHaveLength(1);
  });

  it('reports every session that newly needs attention', () => {
    const events = newlyNeedingAttention(new Map(), [
      session('a', 'awaiting_approval', { pendingApproval: approval }),
      session('b', 'error', { errorMessage: 'boom' }),
      session('c', 'working'),
    ]);
    expect(events.map((e) => e.sessionId)).toEqual(['a', 'b']);
  });

  it('ignores an awaiting session with no approval attached', () => {
    expect(newlyNeedingAttention(new Map(), [session('a', 'awaiting_approval')])).toHaveLength(0);
  });
});

describe('questions', () => {
  const asking = (since: number) =>
    session('a', 'idle', { needsAction: { request: 'tabs or spaces?', since } });

  it('notifies when a session ends its turn asking something', () => {
    // The session sits in 'idle' while asking, so watching state alone would
    // never see it — the key has to include the question.
    const events = newlyNeedingAttention(new Map([['a', 'working']]), [asking(1)]);
    expect(events[0]).toMatchObject({ kind: 'question', detail: 'tabs or spaces?' });
  });

  it('does not re-notify for the same unanswered question', () => {
    const current = [asking(1)];
    expect(newlyNeedingAttention(stateMap(current), current)).toHaveLength(0);
  });

  it('notifies again for a genuinely new question', () => {
    const first = [asking(1)];
    expect(newlyNeedingAttention(stateMap(first), [asking(2)])).toHaveLength(1);
  });
});

describe('titleFor', () => {
  it('distinguishes blocked from needing approval', () => {
    expect(titleFor({ sessionId: 'a', name: 'api', kind: 'error', detail: '' })).toBe('api — blocked');
    expect(titleFor({ sessionId: 'a', name: 'api', kind: 'awaiting_approval', detail: '' })).toBe(
      'api — needs approval',
    );
    expect(titleFor({ sessionId: 'a', name: 'api', kind: 'question', detail: '' })).toBe(
      'api — asked you a question',
    );
  });
});
