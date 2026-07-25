import type { PlanTier, UsageSnapshot, UsageWindow } from '@claudia/shared';
import {
  billableTokens,
  referenceFromHistory,
  referenceFromTier,
  remainingLevel,
  remainingPct,
  SESSION_WINDOW_HOURS,
  WEEKLY_WINDOW_HOURS,
  type Reference,
} from './plan-limits.js';
import { UsageReader } from './usage-reader.js';

const HOUR_MS = 60 * 60 * 1000;

/** Owns the reader, the rescan cadence, and snapshot assembly for the UI. */
export class UsageService {
  private reader = new UsageReader();
  private tier: PlanTier = 'auto';
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onChange: () => void) {}

  start(intervalMs = 30_000): void {
    void this.rescan();
    this.timer = setInterval(() => void this.rescan(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  setTier(tier: PlanTier): void {
    this.tier = tier;
    this.onChange();
  }

  private async rescan(): Promise<void> {
    try {
      await this.reader.scan();
    } catch {
      // A single unreadable log must not take the panel down.
    }
    this.onChange();
  }

  snapshot(now = Date.now()): UsageSnapshot {
    const reference = this.reference(now);
    const weekAgo = now - WEEKLY_WINDOW_HOURS * HOUR_MS;

    const windows: UsageWindow[] = [
      this.buildWindow('5-hour window', SESSION_WINDOW_HOURS, reference?.sessionTokens ?? null, reference, now),
      this.buildWindow('Last 7 days', WEEKLY_WINDOW_HOURS, reference?.weeklyTokens ?? null, reference, now),
    ];

    return {
      tier: this.tier,
      windows,
      byProject: this.reader.store
        .groupBy('project', weekAgo)
        .slice(0, 8)
        .map((g) => ({
          project: g.key,
          billableTokens: billableTokens(g.tokens),
          outputTokens: g.tokens.outputTokens,
        })),
      byModel: this.reader.store
        .groupBy('model', weekAgo)
        // <synthetic> is Claude Code's own bookkeeping, not a model the user chose.
        .filter((g) => g.key !== '<synthetic>' && g.key !== 'unknown')
        .slice(0, 6)
        .map((g) => ({ model: g.key, billableTokens: billableTokens(g.tokens) })),
      scannedAt: this.reader.scannedAt,
      scanning: this.reader.isScanning,
    };
  }

  private reference(now: number): Reference | null {
    if (this.tier !== 'auto' && this.tier !== 'custom') return referenceFromTier(this.tier);
    const daily = this.reader.store.dailyTotals(now).map(billableTokens);
    return referenceFromHistory(daily);
  }

  private buildWindow(
    label: string,
    hours: number,
    referenceTokens: number | null,
    reference: Reference | null,
    now: number,
  ): UsageWindow {
    const tokens = this.reader.store.totals(now - hours * HOUR_MS);
    const billable = billableTokens(tokens);
    const pct = referenceTokens === null ? null : remainingPct(billable, referenceTokens);
    return {
      label,
      hours,
      tokens,
      billableTokens: billable,
      referenceTokens,
      referenceLabel: reference?.label ?? 'not enough history yet',
      remainingPct: pct,
      level: remainingLevel(pct ?? 100),
    };
  }
}
