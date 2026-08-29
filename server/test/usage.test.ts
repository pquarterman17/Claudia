import { describe, expect, it } from 'vitest';
import {
  billableTokens,
  median,
  referenceFromHistory,
  referenceFromTier,
  remainingLevel,
  remainingPct,
} from '../src/plan-limits.js';
import { decodeProject } from '../src/usage-reader.js';
import { UsageStore } from '../src/usage-store.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function sample(over: Partial<Parameters<UsageStore['add']>[0]> = {}) {
  return {
    ts: NOW,
    project: 'p',
    model: 'm',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...over,
  };
}

describe('billableTokens', () => {
  it('discounts cache reads to a tenth, as pricing does', () => {
    // Raw cache reads dominate by orders of magnitude; counting them at full
    // weight would make any ceiling meaningless.
    expect(
      billableTokens({ inputTokens: 100, outputTokens: 50, cacheCreationTokens: 10, cacheReadTokens: 1000 }),
    ).toBe(100 + 50 + 10 + 100);
  });

  it('is zero for an empty turn', () => {
    expect(billableTokens({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })).toBe(0);
  });
});

describe('referenceFromHistory', () => {
  it('builds a weekly reference from the median day, not the mean', () => {
    // One runaway day must not redefine "typical" — that is the whole reason
    // the baseline is self-derived rather than an invented constant.
    const ref = referenceFromHistory([100, 100, 100, 100, 10_000]);
    expect(ref?.weeklyTokens).toBe(700);
  });

  it('scales the 5-hour reference below the daily median', () => {
    const ref = referenceFromHistory([480, 480]);
    expect(ref?.sessionTokens).toBe(100); // 480 / (24/5)
    expect(ref?.sessionTokens).toBeLessThan(ref!.weeklyTokens);
  });

  it('refuses to guess from too little history', () => {
    expect(referenceFromHistory([])).toBeNull();
    expect(referenceFromHistory([500])).toBeNull();
    expect(referenceFromHistory([0, 0, 0])).toBeNull();
  });

  it('ignores zero days when judging whether there is enough history', () => {
    expect(referenceFromHistory([0, 100, 200])).not.toBeNull();
  });
});

describe('referenceFromTier', () => {
  it('applies the published 5x and 20x multipliers to the Pro estimate', () => {
    const pro = referenceFromTier('pro').weeklyTokens;
    expect(referenceFromTier('max5x').weeklyTokens).toBe(pro * 5);
    expect(referenceFromTier('max20x').weeklyTokens).toBe(pro * 20);
  });

  it('labels itself as an estimate so the UI cannot imply server truth', () => {
    expect(referenceFromTier('max20x').label).toMatch(/estimate/i);
  });
});

describe('median', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('is zero for no samples', () => {
    expect(median([])).toBe(0);
  });
});

describe('remainingPct', () => {
  it('reports what is left, not what is used', () => {
    expect(remainingPct(250, 1000)).toBe(75);
  });

  it('clamps rather than going negative when over budget', () => {
    expect(remainingPct(5000, 1000)).toBe(0);
  });

  it('treats a zero ceiling as exhausted instead of dividing by zero', () => {
    expect(remainingPct(0, 0)).toBe(0);
  });

  it.each([
    [100, 'ok'],
    [35, 'ok'],
    [34, 'low'],
    [15, 'low'],
    [14, 'critical'],
    [0, 'critical'],
  ])('%i%% left is %s', (pct, level) => {
    expect(remainingLevel(pct)).toBe(level);
  });
});

describe('UsageStore', () => {
  it('sums samples that share a bucket', () => {
    const s = new UsageStore();
    s.add(sample({ outputTokens: 10 }));
    s.add(sample({ ts: NOW + 1000, outputTokens: 5 }));
    expect(s.size).toBe(1);
    expect(s.totals(0).outputTokens).toBe(15);
  });

  it('excludes samples older than the window', () => {
    const s = new UsageStore();
    s.add(sample({ ts: NOW - 6 * HOUR, outputTokens: 999 }));
    s.add(sample({ ts: NOW, outputTokens: 7 }));
    expect(s.totals(NOW - 5 * HOUR).outputTokens).toBe(7);
  });

  it('groups by project and by model independently', () => {
    const s = new UsageStore();
    s.add(sample({ project: 'a', model: 'opus', outputTokens: 10 }));
    s.add(sample({ project: 'b', model: 'opus', outputTokens: 3 }));

    expect(s.groupBy('project', 0).map((g) => g.key)).toEqual(['a', 'b']); // largest first
    expect(s.groupBy('model', 0)).toHaveLength(1);
    expect(s.groupBy('model', 0)[0]?.tokens.outputTokens).toBe(13);
  });

  it('gives per-day totals and excludes today as a partial day', () => {
    const s = new UsageStore();
    const dayMs = 24 * HOUR;
    s.add(sample({ ts: NOW - 2 * dayMs, outputTokens: 5 }));
    s.add(sample({ ts: NOW - 1 * dayMs, outputTokens: 9 }));
    s.add(sample({ ts: NOW, outputTokens: 1000 })); // today — must not skew the baseline
    expect(s.dailyTotals(NOW).map((t) => t.outputTokens)).toEqual([5, 9]);
  });

  it('prunes stale buckets to bound memory', () => {
    const s = new UsageStore();
    s.add(sample({ ts: NOW - 30 * 24 * HOUR }));
    s.add(sample({ ts: NOW }));
    s.prune(NOW);
    expect(s.size).toBe(1);
  });
});

describe('decodeProject', () => {
  it('shows the recognisable tail of an encoded project directory', () => {
    expect(decodeProject('/x/.claude/projects/C--Users-dev-git-Claudia/abc.jsonl')).toBe('git/Claudia');
  });

  it('handles Windows separators', () => {
    expect(decodeProject('C:\\x\\projects\\C--Users-dev-git-gamma\\s.jsonl')).toBe('git/gamma');
  });
});
