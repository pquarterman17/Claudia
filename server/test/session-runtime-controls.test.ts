import { describe, expect, it, vi } from 'vitest';
import { SessionRuntimeControls, type RuntimeControlQuery } from '../src/session-runtime-controls.js';

describe('SessionRuntimeControls.ensureOutputStyles', () => {
  it('leaves outputStyles undefined when the query cannot fetch them (Codex, or before the first message)', async () => {
    const controls = new SessionRuntimeControls();
    const apply = vi.fn();
    controls.ensureOutputStyles(null, apply);
    // fetchOutputStyles resolves asynchronously even for the null-query path.
    await Promise.resolve();
    await Promise.resolve();
    expect(controls.outputStyles).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });

  it('fetches once, caches the result, and calls apply exactly once', async () => {
    const controls = new SessionRuntimeControls();
    let calls = 0;
    const q: RuntimeControlQuery = {
      initializationResult: async () => {
        calls += 1;
        return { output_style: 'default', available_output_styles: ['default', 'concise'] };
      },
    };
    const apply = vi.fn();
    controls.ensureOutputStyles(q, apply);
    controls.ensureOutputStyles(q, apply); // second call before the first resolves — must not double-fetch
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(controls.outputStyles).toEqual({ current: 'default', available: ['default', 'concise'] });

    // A later call, once cached, must not fetch again either.
    controls.ensureOutputStyles(q, apply);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});

describe('SessionRuntimeControls.setOutputStyle', () => {
  it('sends the request but leaves outputStyles undefined if it was never fetched', async () => {
    const controls = new SessionRuntimeControls();
    const applyFlagSettings = vi.fn(async () => undefined);
    await controls.setOutputStyle({ applyFlagSettings }, 'concise');
    expect(applyFlagSettings).toHaveBeenCalledWith({ outputStyle: 'concise' });
    expect(controls.outputStyles).toBeUndefined();
  });

  it('updates current optimistically once styles are known — the CLI applies it next turn', async () => {
    const controls = new SessionRuntimeControls();
    controls.outputStyles = { current: 'default', available: ['default', 'concise'] };
    await controls.setOutputStyle({ applyFlagSettings: async () => undefined }, 'concise');
    expect(controls.outputStyles).toEqual({ current: 'concise', available: ['default', 'concise'] });
  });
});
