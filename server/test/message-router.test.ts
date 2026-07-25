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

  it('unknown message types are inert', () => {
    const r = routeMessage({ type: 'stream_event', event: {} }, T0);
    expect(r.steps).toHaveLength(0);
    expect(r.state).toBeUndefined();
  });

  it('tolerates malformed assistant payloads', () => {
    expect(() => routeMessage({ type: 'assistant' }, T0)).not.toThrow();
    expect(() => routeMessage({ type: 'assistant', message: { content: 'nope' } }, T0)).not.toThrow();
  });
});
