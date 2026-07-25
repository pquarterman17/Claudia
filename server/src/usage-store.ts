import type { TokenCounts } from '@claudia/shared';

export const BUCKET_MS = 5 * 60 * 1000;
const RETAIN_MS = 8 * 24 * 60 * 60 * 1000; // a little over the 7-day window

export interface UsageSample extends TokenCounts {
  ts: number;
  project: string;
  model: string;
}

const EMPTY: TokenCounts = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

function add(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
  };
}

/**
 * Rolling usage in 5-minute buckets, keyed by bucket/project/model.
 *
 * Bucketing rather than keeping every message bounds memory regardless of how
 * much history is scanned, and 5 minutes is fine enough that the edges of a
 * 5-hour window stay accurate.
 *
 * Pure and I/O-free so window arithmetic is testable without touching disk.
 */
export class UsageStore {
  private buckets = new Map<string, TokenCounts>();

  add(sample: UsageSample): void {
    const bucket = Math.floor(sample.ts / BUCKET_MS) * BUCKET_MS;
    const key = `${bucket}|${sample.project}|${sample.model}`;
    this.buckets.set(key, add(this.buckets.get(key) ?? EMPTY, sample));
  }

  /** Totals for everything at or after `since`. */
  totals(since: number): TokenCounts {
    let out = EMPTY;
    for (const [key, counts] of this.buckets) {
      if (bucketOf(key) >= since) out = add(out, counts);
    }
    return out;
  }

  /** Per-key totals since a cutoff, largest first. `field` picks the grouping. */
  groupBy(field: 'project' | 'model', since: number): Array<{ key: string; tokens: TokenCounts }> {
    const index = field === 'project' ? 1 : 2;
    const grouped = new Map<string, TokenCounts>();
    for (const [key, counts] of this.buckets) {
      if (bucketOf(key) < since) continue;
      const name = key.split('|')[index] ?? 'unknown';
      grouped.set(name, add(grouped.get(name) ?? EMPTY, counts));
    }
    return [...grouped.entries()]
      .map(([key, tokens]) => ({ key, tokens }))
      .sort((a, b) => b.tokens.outputTokens - a.tokens.outputTokens);
  }

  /**
   * Per-calendar-day totals, oldest first, for deriving a personal baseline.
   * Today is excluded — a partial day would drag the median down.
   */
  dailyTotals(now = Date.now()): TokenCounts[] {
    const byDay = new Map<string, TokenCounts>();
    const today = dayKey(now);
    for (const [key, counts] of this.buckets) {
      const day = dayKey(bucketOf(key));
      if (day === today) continue;
      byDay.set(day, add(byDay.get(day) ?? EMPTY, counts));
    }
    return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, counts]) => counts);
  }

  /** Drops buckets older than the retention horizon. */
  prune(now = Date.now()): void {
    const cutoff = now - RETAIN_MS;
    for (const key of this.buckets.keys()) {
      if (bucketOf(key) < cutoff) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

function bucketOf(key: string): number {
  return Number(key.slice(0, key.indexOf('|')));
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}
