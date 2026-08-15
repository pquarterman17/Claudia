import { describe, expect, it } from 'vitest';
import { parseContextReply } from '../src/context-parser.js';

describe('parseContextReply', () => {
  it('reads compact token quantities and model from /context', () => {
    const parsed = parseContextReply(
      '## Context Usage\n**Model:** claude-fable-5\n**Tokens:** 66.5k / 1m (7%)\n| Free space | 933.5k | 93.3% |',
      123,
    );
    expect(parsed).toEqual({
      model: 'claude-fable-5',
      usedTokens: 66_500,
      maxTokens: 1_000_000,
      usedPct: 7,
      freeTokens: 933_500,
      fetchedAt: 123,
    });
  });

  it('rejects unrelated assistant text', () => {
    expect(parseContextReply('The task is complete.')).toBeNull();
  });
});
