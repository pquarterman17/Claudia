import { describe, expect, it } from 'vitest';
import { routeCodexMessage } from '../src/codex-router.js';
import { encodeDecision } from '../src/codex-protocol.js';

/**
 * Fixtures follow the shapes documented in codex-rs/app-server/README.md and
 * codex-rs/protocol/src/protocol.rs, not invented ones. Where a field name was
 * ambiguous across sources the Rust definition wins, because that is what the
 * running binary serialises.
 */

describe('thread and turn lifecycle', () => {
  it('adopts the thread id so the session can be resumed later', () => {
    const r = routeCodexMessage('thread/started', { threadId: 'th_abcdef123456' });
    expect(r.claudeSessionId).toBe('th_abcdef123456');
    expect(r.state).toBe('working');
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
  it('reads the separate tokenUsage notification, which is where Codex reports it', () => {
    // Unlike the Claude SDK, usage does not ride turn completion.
    const r = routeCodexMessage('thread/tokenUsage/updated', {
      usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 300, cache_write_input_tokens: 50 },
    });
    expect(r.modelUsage?.[0]).toMatchObject({
      inputTokens: 1200,
      cacheReadTokens: 800,
      outputTokens: 300,
      cacheCreationTokens: 50,
    });
  });

  it('reports zero cost rather than inventing one, since Codex reports none', () => {
    const r = routeCodexMessage('thread/tokenUsage/updated', { usage: { input_tokens: 10, output_tokens: 5 } });
    expect(r.modelUsage?.[0]?.costUsd).toBe(0);
  });

  it('ignores an all-zero usage payload instead of emitting an empty row', () => {
    const r = routeCodexMessage('thread/tokenUsage/updated', { usage: { input_tokens: 0, output_tokens: 0 } });
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
