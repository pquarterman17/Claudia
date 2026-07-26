/**
 * Plan-usage and cost types, shared by the server's usage service and the UI's
 * usage panel.
 *
 * Split out of index.ts rather than raising the module-size ceiling: three
 * separate pieces of work grew this area at once (real limits from `/cost`,
 * per-model windows, custom ceilings) and it is a coherent subject of its own.
 * Re-exported from index.ts, so `@claudia/shared` consumers are unaffected.
 */

// Type-only, so the cycle with index.ts is erased at compile time: TokenCounts
// describes raw token fields used by both usage and session reporting.
import type { TokenCounts } from './index.js';

/** 'auto' derives a reference from the user's own history; the rest are estimates. */
export type PlanTier = 'auto' | 'pro' | 'max5x' | 'max20x' | 'custom';

export interface UsageWindow {
  label: string;
  hours: number;
  tokens: TokenCounts;
  /** Pricing-weighted total — cache reads counted at 10%, as billing does. */
  billableTokens: number;
  /** What the bar is measured against. Null when there's too little history. */
  referenceTokens: number | null;
  /** Where the reference came from, e.g. "typical for you". */
  referenceLabel: string;
  remainingPct: number | null;
  level: 'ok' | 'low' | 'critical';
}

export interface ProjectUsage {
  project: string;
  billableTokens: number;
  outputTokens: number;
}

/**
 * One accounting window from the CLI's own `/cost` reply — see
 * server/src/cost-parser.ts. `resetsAt` is kept as the raw string the CLI
 * prints ("Jul 26, 8:30pm (America/New_York)"); turning it into a real Date
 * would mean guessing a timezone offset the string only names, never encodes.
 */
export interface CostWindow {
  label: string;
  kind: 'session' | 'week' | 'week-model';
  model?: string;
  usedPct: number;
  resetsAt: string;
}

/** Real plan usage last fetched via `/cost`, kept alongside the history estimate below. */
export interface RealUsage {
  windows: CostWindow[];
  fetchedAt: number;
  /** Which session's `/cost` prompt produced this — usage is account-wide, but the UI still names its source. */
  sessionId: string;
}

export interface UsageSnapshot {
  tier: PlanTier;
  windows: UsageWindow[];
  byProject: ProjectUsage[];
  byModel: Array<{ model: string; billableTokens: number }>;
  /** When the local logs were last scanned. */
  scannedAt: number;
  /** True while the first (potentially slow) scan is still running. */
  scanning: boolean;
  /** Real plan allowance from `/cost`, or null if never fetched or the reply didn't parse. The windows above remain the fallback either way. */
  real: RealUsage | null;
  /** True while a `/cost` fetch is in flight, so the UI does not fire a second one. */
  realPending: boolean;
}
