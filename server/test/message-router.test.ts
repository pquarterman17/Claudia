import { describe, expect, it } from 'vitest';
import { routeMessage } from '../src/message-router.js';

const T0 = Date.now() - 5000;

describe('routeMessage', () => {
  it('system/init sets working, model and claude session id', () => {
    const r = routeMessage(
      { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 'abc-123', cwd: '/repo' },
      T0,
    );
    expect(r.state).toBe('working');
    expect(r.model).toBe('claude-opus-4-8');
    expect(r.claudeSessionId).toBe('abc-123');
    expect(r.steps[0]?.kind).toBe('info');
  });

  it('system/init extracts slash_commands when present', () => {
    const r = routeMessage(
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-4-8',
        session_id: 'abc-123',
        cwd: '/repo',
        slash_commands: ['compact', 'clear', 'my-skill'],
      },
      T0,
    );
    // Advertised commands are all kept; the CLI's unadvertised-but-working
    // built-ins are merged in on top (see mergeCommands). This is the
    // init-message fallback — bare names only, no description/argumentHint
    // yet, until listCommands()'s live supportedCommands() fetch lands.
    const names = r.slashCommands?.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['compact', 'clear', 'my-skill']));
    expect(names).toContain('cost');
    expect(r.slashCommands?.every((c) => c.description === undefined)).toBe(true);
  });

  it('system/init omits slashCommands when absent', () => {
    const r = routeMessage(
      { type: 'system', subtype: 'init', model: 'claude-opus-4-8', session_id: 'abc-123', cwd: '/repo' },
      T0,
    );
    expect(r.slashCommands).toBeUndefined();
  });

  it('system/init filters out non-string entries in slash_commands', () => {
    const r = routeMessage(
      {
        type: 'system',
        subtype: 'init',
        model: 'claude-opus-4-8',
        session_id: 'abc-123',
        cwd: '/repo',
        slash_commands: ['compact', 42, null, { name: 'nope' }, 'clear'],
      },
      T0,
    );
    const names = r.slashCommands?.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['compact', 'clear']));
    // The point of this case: nothing non-string survives the filter.
    expect(r.slashCommands?.every((c) => typeof c.name === 'string')).toBe(true);
    expect(names).not.toContain('nope');
  });

  it('assistant tool_use produces a feed step classified by tool', () => {
    const r = routeMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] },
      },
      T0,
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.kind).toBe('bash');
    expect(r.steps[0]?.meta).toBe('npm test');
    expect(r.state).toBe('working');
  });

  it('IGNORES usage on assistant messages', () => {
    // output_tokens here is the SDK's placeholder (observed 1 against a real 406),
    // and cache_read repeats the same cache every call. Trusting it undercounts
    // output ~400x and inflates input. Only result messages carry usage.
    const r = routeMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'a long answer' }],
          usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 23876 },
        },
      },
      T0,
    );
    expect(r.modelUsage).toBeUndefined();
  });

  it('takes cumulative per-model usage from the result message', () => {
    const r = routeMessage(
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 0.0983155,
        modelUsage: {
          'claude-opus-5[1m]': {
            inputTokens: 4,
            outputTokens: 1079,
            cacheReadInputTokens: 23876,
            cacheCreationInputTokens: 3523,
            costUSD: 0.097734,
          },
          'claude-haiku-4-5-20251001': {
            inputTokens: 522,
            outputTokens: 12,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.000582,
          },
        },
      },
      T0,
    );
    expect(r.modelUsage).toHaveLength(2);
    const opus = r.modelUsage?.find((m) => m.model.startsWith('claude-opus'));
    expect(opus).toMatchObject({ outputTokens: 1079, cacheReadTokens: 23876, costUsd: 0.097734 });
    // Per-model split is what lets the weekly Opus window be tracked separately.
    expect(r.modelUsage?.find((m) => m.model.includes('haiku'))?.outputTokens).toBe(12);
  });

  it('pairs a tool_use with its step and marks it running', () => {
    const r = routeMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'toolu_9', name: 'Bash', input: { command: 'ls' } }] },
      },
      T0,
    );
    expect(r.steps[0]?.status).toBe('running');
    expect(r.toolStarts).toEqual([{ toolUseId: 'toolu_9', stepId: r.steps[0]?.id }]);
  });

  it('extracts tool results from user messages', () => {
    const r = routeMessage(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'hi' },
            { type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'boom' },
          ],
        },
      },
      T0,
    );
    // is_error is absent on success rather than false — must not read as an error.
    expect(r.toolEnds).toEqual([
      { toolUseId: 'a', isError: false },
      { toolUseId: 'b', isError: true },
    ]);
    expect(r.steps).toHaveLength(0);
  });

  it('ignores user messages that are plain prompts', () => {
    const r = routeMessage({ type: 'user', message: { content: 'just text' } }, T0);
    expect(r.toolEnds).toBeUndefined();
  });

  it('reports an automatic compaction with how large it was before', () => {
    const r = routeMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 152341 },
        uuid: 'u1',
        session_id: 's1',
      },
      T0,
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.kind).toBe('info');
    expect(r.steps[0]?.title).toContain('automatic');
    // Grouping is pinned to en-US in the router precisely so this assertion is
    // not a coin flip on the host locale.
    expect(r.steps[0]?.meta).toContain('152,341 tokens');
  });

  it('distinguishes a user-invoked /compact from an automatic one', () => {
    const r = routeMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'manual', pre_tokens: 98000 },
      },
      T0,
    );
    expect(r.steps[0]?.title).toContain('requested');
    expect(r.steps[0]?.title).not.toContain('automatic');
    expect(r.steps[0]?.meta).toContain('/compact');
  });

  it('tolerates a compact_boundary message with metadata missing', () => {
    expect(() => routeMessage({ type: 'system', subtype: 'compact_boundary' }, T0)).not.toThrow();
    const r = routeMessage({ type: 'system', subtype: 'compact_boundary' }, T0);
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.kind).toBe('info');
  });

  it('turns post_turn_summary into a needs-action signal', () => {
    // Structured, so a question does not have to be spotted in the prose.
    const r = routeMessage(
      {
        type: 'system',
        subtype: 'post_turn_summary',
        status_category: 'blocked',
        status_detail: 'indentation style choice needed',
        needs_action: 'reply: tabs, or spaces?',
      },
      T0,
    );
    expect(r.needsAction).toMatchObject({
      request: 'reply: tabs, or spaces?',
      detail: 'indentation style choice needed',
    });
    expect(r.steps[0]?.title).toBe('Waiting on you');
  });

  it('clears needs-action when a turn ends without one', () => {
    const r = routeMessage({ type: 'system', subtype: 'post_turn_summary', status_category: 'ok' }, T0);
    expect(r.needsAction).toBeNull();
  });

  it('ignores an empty needs_action', () => {
    const r = routeMessage(
      { type: 'system', subtype: 'post_turn_summary', needs_action: '   ' },
      T0,
    );
    expect(r.needsAction).toBeNull();
  });

  it('survives a result with no modelUsage', () => {
    const r = routeMessage({ type: 'result', subtype: 'success', total_cost_usd: 1 }, T0);
    expect(r.modelUsage).toBeUndefined();
    expect(r.costUsd).toBe(1);
  });

  it('classifies Edit and Read tools distinctly', () => {
    const edit = routeMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/a.ts' } }] } },
      T0,
    );
    const read = routeMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } }] } },
      T0,
    );
    expect(edit.steps[0]?.kind).toBe('edit');
    expect(read.steps[0]?.kind).toBe('read');
  });

  it('reports a write tool as a file the session set out to change', () => {
    const r = routeMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/a.ts' } }] } },
      T0,
    );
    expect(r.fileWrites).toEqual([{ toolUseId: 't1', path: '/a.ts' }]);
  });

  it("reads NotebookEdit's path from notebook_path, where it keeps it", () => {
    const r = routeMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'NotebookEdit', input: { notebook_path: '/a.ipynb' } }] },
      },
      T0,
    );
    expect(r.fileWrites).toEqual([{ toolUseId: 't1', path: '/a.ipynb' }]);
  });

  it('does not treat reading, searching or running a command as a write', () => {
    // Read and Glob carry a path of their own; a commit scoped to those would
    // cover every file the session merely looked at.
    for (const [name, input] of [
      ['Read', { file_path: '/a.ts' }],
      ['Glob', { pattern: '**/*.ts', path: '/src' }],
      ['Bash', { command: 'npm run build' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = routeMessage(
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } },
        T0,
      );
      expect(r.fileWrites, name).toBeUndefined();
    }
  });

  it('ignores a write tool call with no id to confirm it later', () => {
    const r = routeMessage(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/a.ts' } }] } },
      T0,
    );
    expect(r.fileWrites).toBeUndefined();
  });

  it('drops whitespace-only assistant text', () => {
    const r = routeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '   \n ' }] } }, T0);
    expect(r.steps).toHaveLength(0);
  });

  it('result/success settles to idle and records cost', () => {
    const r = routeMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.42 }, T0);
    expect(r.state).toBe('idle');
    expect(r.costUsd).toBe(0.42);
    expect(r.steps[0]?.durMs).toBeGreaterThanOrEqual(5000);
  });

  it('result/error_* goes to error with the subtype as the message', () => {
    const r = routeMessage({ type: 'result', subtype: 'error_max_turns' }, T0);
    expect(r.state).toBe('error');
    expect(r.errorMessage).toBe('error_max_turns');
  });

  it('extracts text deltas from stream events', () => {
    const r = routeMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hel' } } },
      T0,
    );
    expect(r.draftDelta).toBe('Hel');
    expect(r.steps).toHaveLength(0);
  });

  it('ignores non-text stream events', () => {
    // Tool-input deltas also stream; only prose belongs in the draft row.
    const r = routeMessage(
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } },
      T0,
    );
    expect(r.draftDelta).toBeUndefined();
    expect(routeMessage({ type: 'stream_event', event: { type: 'message_start' } }, T0).draftDelta).toBeUndefined();
  });

  it('unknown message types are inert', () => {
    const r = routeMessage({ type: 'unheard_of' }, T0);
    expect(r.steps).toHaveLength(0);
    expect(r.state).toBeUndefined();
  });

  it('tolerates malformed assistant payloads', () => {
    expect(() => routeMessage({ type: 'assistant' }, T0)).not.toThrow();
    expect(() => routeMessage({ type: 'assistant', message: { content: 'nope' } }, T0)).not.toThrow();
  });
});

describe('routeMessage transcript extraction', () => {
  it('extracts assistant text in full, without truncation', () => {
    const longText = 'a very long reply. '.repeat(50); // far past the feed's 200-char truncation
    const r = routeMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
      T0,
    );
    expect(r.transcriptItems).toHaveLength(1);
    expect(r.transcriptItems?.[0]).toMatchObject({ kind: 'assistant', text: longText });
    expect(r.transcriptItems?.[0]?.text.length).toBe(longText.length);
    expect(typeof r.transcriptItems?.[0]?.ts).toBe('number');
  });

  it('extracts thinking blocks with their text under the thinking key', () => {
    const r = routeMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'considering the options' }] },
      },
      T0,
    );
    expect(r.transcriptItems).toEqual([
      expect.objectContaining({ kind: 'thinking', text: 'considering the options' }),
    ]);
  });

  it('extracts tool_use blocks with the tool name and formatted input', () => {
    const r = routeMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test' } }],
        },
      },
      T0,
    );
    expect(r.transcriptItems).toEqual([
      expect.objectContaining({
        kind: 'tool_use',
        toolName: 'Bash',
        text: JSON.stringify({ command: 'npm test' }, null, 2),
      }),
    ]);
  });

  it('extracts a mix of text, thinking and tool_use from one assistant message, in order', () => {
    const r = routeMessage(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'first, think' },
            { type: 'text', text: 'here is the answer' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          ],
        },
      },
      T0,
    );
    expect(r.transcriptItems?.map((i) => i.kind)).toEqual(['thinking', 'assistant', 'tool_use']);
  });

  it('extracts tool_result content that is a plain string', () => {
    const r = routeMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'file contents here' }] },
      },
      T0,
    );
    expect(r.transcriptItems).toEqual([
      expect.objectContaining({ kind: 'tool_result', text: 'file contents here' }),
    ]);
  });

  it('extracts tool_result content that is an object, as formatted JSON', () => {
    const payload = [{ type: 'text', text: 'nested content block' }];
    const r = routeMessage(
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: payload }] },
      },
      T0,
    );
    expect(r.transcriptItems).toEqual([
      expect.objectContaining({ kind: 'tool_result', text: JSON.stringify(payload, null, 2) }),
    ]);
  });

  it('a message with no transcript content yields no items', () => {
    expect(routeMessage({ type: 'result', subtype: 'success', total_cost_usd: 0.1 }, T0).transcriptItems).toBeUndefined();
    expect(routeMessage({ type: 'system', subtype: 'init', model: 'm' }, T0).transcriptItems).toBeUndefined();
    expect(routeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '   ' }] } }, T0).transcriptItems).toBeUndefined();
    expect(routeMessage({ type: 'user', message: { content: 'just text' } }, T0).transcriptItems).toBeUndefined();
  });
});
