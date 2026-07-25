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
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
          usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 90 },
        },
      },
      T0,
    );
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]?.kind).toBe('bash');
    expect(r.steps[0]?.meta).toBe('npm test');
    expect(r.inputTokens).toBe(100); // input + cache reads
    expect(r.outputTokens).toBe(4);
    expect(r.state).toBe('working');
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
