import { describe, expect, it } from 'vitest';
import { usageHeadline } from '../src/components/UsagePanel';

describe('usageHeadline', () => {
  const window = {
    label: 'Current session', billableTokens: 280, referenceTokens: 100,
    referenceLabel: 'typical', remainingPct: 0, level: 'critical' as const,
    tokens: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };

  it('uses a clear multiple after usage passes the typical reference', () => {
    expect(usageHeadline(window)).toEqual({ value: '2.8×', suffix: 'typical' });
  });

  it('keeps remaining usage language below the reference', () => {
    expect(usageHeadline({ ...window, billableTokens: 50, remainingPct: 50 })).toEqual({ value: '50%', suffix: 'left' });
  });
});
