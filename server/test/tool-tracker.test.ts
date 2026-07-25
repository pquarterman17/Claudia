import { describe, expect, it } from 'vitest';
import { ToolTracker } from '../src/tool-tracker.js';

describe('ToolTracker', () => {
  it('matches a result to its call and measures duration', () => {
    const t = new ToolTracker();
    t.begin('toolu_1', 'step-1', 1000);
    expect(t.complete('toolu_1', false, 1350)).toEqual({ stepId: 'step-1', durMs: 350, isError: false });
  });

  it('matches out-of-order results by id, not by call order', () => {
    // The real driver for this class: a fast Read can return before a slow Bash
    // that was issued first. Observed live against the SDK.
    const t = new ToolTracker();
    t.begin('bash', 'step-bash', 1000);
    t.begin('read', 'step-read', 1010);

    expect(t.complete('read', false, 1100)).toMatchObject({ stepId: 'step-read', durMs: 90 });
    expect(t.complete('bash', false, 3000)).toMatchObject({ stepId: 'step-bash', durMs: 2000 });
  });

  it('carries the error flag through', () => {
    const t = new ToolTracker();
    t.begin('x', 'step-x', 0);
    expect(t.complete('x', true, 5)?.isError).toBe(true);
  });

  it('returns null for a result whose call was never seen', () => {
    expect(new ToolTracker().complete('ghost', false)).toBeNull();
  });

  it('does not complete the same call twice', () => {
    const t = new ToolTracker();
    t.begin('x', 'step-x', 0);
    expect(t.complete('x', false, 10)).not.toBeNull();
    expect(t.complete('x', false, 20)).toBeNull();
  });

  it('never reports a negative duration if clocks go backwards', () => {
    const t = new ToolTracker();
    t.begin('x', 'step-x', 5000);
    expect(t.complete('x', false, 4000)?.durMs).toBe(0);
  });

  it('lists outstanding steps so they can be marked abandoned', () => {
    const t = new ToolTracker();
    t.begin('a', 'step-a', 0);
    t.begin('b', 'step-b', 0);
    t.complete('a', false, 1);
    expect(t.outstanding()).toEqual(['step-b']);

    t.clear();
    expect(t.outstanding()).toEqual([]);
  });
});
