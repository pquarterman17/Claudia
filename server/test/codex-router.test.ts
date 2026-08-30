import { describe, expect, it } from 'vitest';
import { routeCodexMessage } from '../src/codex-router.js';
import { encodeDecision } from '../src/codex-protocol.js';

/**
 * Fixtures are CAPTURED FROM A LIVE codex-cli 0.151.0, not transcribed from
 * documentation. Two of them were wrong when written from the docs alone and
 * only the real wire showed it: `thread/started` carries { thread: { id } }
 * rather than a top-level threadId, and token usage arrives nested under
 * { tokenUsage: { total: {...} } } in camelCase. Both failed silently — a
 * session with no resumable id, and a permanently zero token count.
 */

describe('thread and turn lifecycle', () => {
  it('adopts the thread id from the nested thread object', () => {
    // Captured payload shape; a top-level threadId does not exist here.
    const r = routeCodexMessage('thread/started', {
      thread: { id: '01a04e56-0e66-7090-b5a0-cd4c80ff5396', sessionId: '01a04e56-0e66-7090-b5a0-cd4c80ff5396', preview: '' },
    });
    expect(r.claudeSessionId).toBe('01a04e56-0e66-7090-b5a0-cd4c80ff5396');
    expect(r.state).toBe('working');
  });

  it('reports no id rather than a wrong one when the thread object is absent', () => {
    expect(routeCodexMessage('thread/started', {}).claudeSessionId).toBeUndefined();
  });

  it('treats a completed turn as the session going idle', () => {
    const r = routeCodexMessage('turn/completed', { turn: { id: 't1', status: 'completed' } });
    expect(r.state).toBe('idle');
    expect(r.steps[0]).toMatchObject({ kind: 'result', title: 'Turn complete' });
  });

  it('distinguishes an interrupted turn, which is not a failure', () => {
    const r = routeCodexMessage('turn/completed', { turn: { status: 'interrupted' } });
    expect(r.state).toBe('idle');
    expect(r.steps[0]?.title).toBe('Turn interrupted');
    expect(r.errorMessage).toBeUndefined();
  });

  it('surfaces a failed turn as an error with its message', () => {
    const r = routeCodexMessage('turn/completed', {
      turn: { status: 'failed', error: { message: 'model overloaded' } },
    });
    expect(r.state).toBe('error');
    expect(r.errorMessage).toBe('model overloaded');
  });
});

describe('token usage', () => {
  it('reads the captured tokenUsage shape: nested under total, camelCase', () => {
    // Real payload from a live turn. Unlike the Claude SDK, usage does not ride
    // turn completion, and `last` covers only the most recent request -- summing
    // that across notifications would over-count, so `total` is the one to read.
    const r = routeCodexMessage('thread/tokenUsage/updated', {
      threadId: 'th_1',
      turnId: 'turn_1',
      tokenUsage: {
        total: { totalTokens: 16875, inputTokens: 1200, cachedInputTokens: 800, cacheWriteInputTokens: 50, outputTokens: 300, reasoningOutputTokens: 0 },
        last: { totalTokens: 9, inputTokens: 4, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 },
      },
    });
    expect(r.modelUsage?.[0]).toMatchObject({
      inputTokens: 1200,
      cacheReadTokens: 800,
      outputTokens: 300,
      cacheCreationTokens: 50,
    });
  });

  it('reports zero cost rather than inventing one, since Codex reports none', () => {
    const r = routeCodexMessage('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 10, outputTokens: 5 } } });
    expect(r.modelUsage?.[0]?.costUsd).toBe(0);
  });

  it('ignores an all-zero usage payload instead of emitting an empty row', () => {
    const r = routeCodexMessage('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 0, outputTokens: 0 } } });
    expect(r.modelUsage).toBeUndefined();
  });
});

describe('items', () => {
  const started = (item: Record<string, unknown>) => routeCodexMessage('item/started', { item });
  const completed = (item: Record<string, unknown>) => routeCodexMessage('item/completed', { item });

  it('opens a tracked step on item/started so completion can patch it', () => {
    const r = started({ id: 'item_1', type: 'commandExecution', command: ['bash', '-lc', 'npm test'], status: 'inProgress' });
    expect(r.steps[0]).toMatchObject({ kind: 'bash', title: 'Command', meta: 'bash -lc npm test' });
    expect(r.toolStarts?.[0]).toMatchObject({ toolUseId: 'item_1' });
  });

  it('closes the SAME step on item/completed rather than adding a second one', () => {
    // The per-item lifecycle is always started -> deltas -> completed, so a
    // finished call must patch, or every command would appear twice.
    const r = completed({ id: 'item_1', type: 'commandExecution', command: ['ls'], status: 'completed' });
    expect(r.steps).toHaveLength(0);
    expect(r.toolEnds?.[0]).toEqual({ toolUseId: 'item_1', isError: false });
  });

  it('marks a declined command as an error, not a success', () => {
    const r = completed({ id: 'item_2', type: 'commandExecution', command: ['rm'], status: 'declined' });
    expect(r.toolEnds?.[0]?.isError).toBe(true);
  });

  it('summarises a multi-file change without listing every path', () => {
    const r = started({
      id: 'item_3',
      type: 'fileChange',
      status: 'inProgress',
      changes: [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }, { path: '/repo/c.ts' }],
    });
    expect(r.steps[0]).toMatchObject({ kind: 'edit' });
    expect(r.steps[0]?.meta).toContain('3 files');
  });

  it('records a completed file change as work the session did', () => {
    // Codex reports the change as already applied and gives nothing to confirm
    // it against later, so it counts at completion rather than at start.
    const r = completed({
      id: 'item_3',
      type: 'fileChange',
      status: 'completed',
      changes: [{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }],
    });
    expect(r.fileWrites).toEqual([{ path: '/repo/a.ts' }, { path: '/repo/b.ts' }]);
  });

  it('claims nothing from a file change that started but has not landed', () => {
    const r = started({ id: 'item_3', type: 'fileChange', status: 'inProgress', changes: [{ path: '/repo/a.ts' }] });
    expect(r.fileWrites).toBeUndefined();
  });

  it('claims nothing from a declined file change', () => {
    const r = completed({ id: 'item_3', type: 'fileChange', status: 'declined', changes: [{ path: '/repo/a.ts' }] });
    expect(r.fileWrites).toBeUndefined();
  });

  it('records an agent message in the transcript, not just the feed', () => {
    const r = completed({ id: 'item_4', type: 'agentMessage', text: 'Done. Two files changed.' });
    expect(r.transcriptItems?.[0]).toMatchObject({ kind: 'assistant', text: 'Done. Two files changed.' });
  });

  it('keeps reasoning out of the feed headline but in the transcript', () => {
    const r = completed({ id: 'item_5', type: 'reasoning', summary: 'Checking the failing test first.' });
    expect(r.transcriptItems?.[0]?.kind).toBe('thinking');
  });

  it('reports sub-agent activity as its own step, since Codex sub-agents are separate threads', () => {
    const r = started({ id: 'item_6', type: 'subAgentActivity', kind: 'started', agentPath: 'reviewer' });
    expect(r.steps[0]?.title).toContain('Sub-agent');
  });

  it('ignores an item type it does not model', () => {
    expect(started({ id: 'x', type: 'imageGeneration' }).steps).toHaveLength(0);
  });
});

describe('streaming and unknown methods', () => {
  it('turns an agent message delta into a streamed draft', () => {
    const r = routeCodexMessage('item/agentMessage/delta', { delta: 'partial ' });
    expect(r.draftDelta).toBe('partial ');
  });

  it('ignores unknown notifications, as the protocol instructs', () => {
    // A newer Codex adding notifications must not break a running tile.
    expect(routeCodexMessage('thread/realtime/outputAudio/delta', { audio: {} })).toEqual({ steps: [] });
  });
});

describe('approval decision encoding', () => {
  it('encodes approve as a bare string', () => {
    expect(encodeDecision({ kind: 'approved' })).toBe('approved');
  });

  it('encodes DENY as an object with a rejection, not the string "deny"', () => {
    // ReviewDecision::Denied is a Rust struct variant. Sending "deny" -- as
    // third-party write-ups claim -- does not error, it just leaves the agent's
    // turn hanging forever.
    expect(encodeDecision({ kind: 'denied', rejection: 'not now' })).toEqual({
      denied: { rejection: 'not now' },
    });
  });

  it('encodes the session-scoped approval and abort variants', () => {
    expect(encodeDecision({ kind: 'approved_for_session' })).toBe('approved_for_session');
    expect(encodeDecision({ kind: 'abort' })).toBe('abort');
  });
});
