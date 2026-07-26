import type { PlanTier, TokenCounts } from '@claudia/shared';

/**
 * Usage accounting.
 *
 * There is no API for real plan limits — no CLI flag, no SDK method, no
 * documented endpoint, and the JSONL carries no quota field. Anthropic publishes
 * tiers only as multipliers and rough prompt counts, never token ceilings.
 *
 * An earlier version of this file invented ceilings from a community estimate.
 * Measured against real logs on this machine that was off by more than an order
 * of magnitude — a week of genuine use came to ~328M weighted tokens against an
 * invented 14M "Max 20x" ceiling — which would peg every bar at 0% and train the
 * user to ignore the panel. Fabricated precision is worse than none.
 *
 * So the reference point is the user's OWN trailing history: "compared with a
 * typical day for you" is self-calibrating, needs no invented constants, and
 * answers the question actually worth asking — am I burning faster than usual?
 * A tier override stays available for anyone who has calibrated real ceilings.
 */

/**
 * Cache reads bill at roughly a tenth of fresh input and dominate raw counts by
 * orders of magnitude (this machine: ~2.9B cache reads against 150k input over a
 * week). Weighting them the way pricing does keeps a total that means something.
 */
export const CACHE_READ_WEIGHT = 0.1;

export function billableTokens(t: TokenCounts): number {
  return (
    t.inputTokens + t.outputTokens + t.cacheCreationTokens + Math.round(t.cacheReadTokens * CACHE_READ_WEIGHT)
  );
}

export const SESSION_WINDOW_HOURS = 5;
export const WEEKLY_WINDOW_HOURS = 24 * 7;

/** Five-hour blocks in a day, used to scale a daily median to the short window. */
const BLOCKS_PER_DAY = 24 / SESSION_WINDOW_HOURS;

export interface Reference {
  sessionTokens: number;
  weeklyTokens: number;
  label: string;
}

/** Optional hard ceilings, if the user has worked out their real limits. */
type FixedTier = Exclude<PlanTier, 'custom' | 'auto'>;

const TIER_WEEKLY: Record<FixedTier, number> = {
  pro: 700_000,
  max5x: 3_500_000,
  max20x: 14_000_000,
};

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * A reference derived from the user's own daily totals. Returns null when there
 * is too little history to say anything — better to show raw numbers than a
 * baseline built from one quiet afternoon.
 */
export function referenceFromHistory(dailyBillable: number[]): Reference | null {
  const days = dailyBillable.filter((d) => d > 0);
  if (days.length < 2) return null;
  const typicalDay = median(days);
  if (typicalDay <= 0) return null;
  return {
    sessionTokens: Math.round(typicalDay / BLOCKS_PER_DAY),
    weeklyTokens: Math.round(typicalDay * 7),
    label: 'typical for you',
  };
}

export function referenceFromTier(tier: FixedTier): Reference {
  const weekly = TIER_WEEKLY[tier];
  return {
    sessionTokens: Math.round(weekly * 0.12),
    weeklyTokens: weekly,
    label: `${tier} estimate`,
  };
}

/**
 * Ceilings the user has calibrated themselves. Used as given — validation
 * (clamping, rounding) happens at the gateway before this is ever called.
 */
export function referenceFromCustom(c: { sessionTokens: number; weeklyTokens: number }): Reference {
  return {
    sessionTokens: c.sessionTokens,
    weeklyTokens: c.weeklyTokens,
    label: 'your ceilings',
  };
}

/**
 * How much of the reference is still unused, clamped to 0–100. Against a
 * self-derived baseline, 0% means "already at a typical week", not "blocked".
 */
export function remainingPct(used: number, reference: number): number {
  if (reference <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - used / reference) * 100)));
}

export function remainingLevel(pct: number): 'ok' | 'low' | 'critical' {
  if (pct < 15) return 'critical';
  if (pct < 35) return 'low';
  return 'ok';
}
