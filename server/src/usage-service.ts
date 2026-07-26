import type { PlanTier, RealUsage, TranscriptItem, UsageSnapshot, UsageWindow } from '@claudia/shared';
import { parseCostReply } from './cost-parser.js';
import {
  billableTokens,
  referenceFromCustom,
  referenceFromHistory,
  referenceFromTier,
  remainingLevel,
  remainingPct,
  SESSION_WINDOW_HOURS,
  WEEKLY_WINDOW_HOURS,
  type Reference,
} from './plan-limits.js';
import { UsageReader } from './usage-reader.js';

/**
 * How long a `/cost` request stays armed. Generous: the prompt may be queued
 * behind a long turn. Short enough that a request that never answers releases
 * the button instead of stranding it on "asking…".
 */
const ARMED_TTL_MS = 5 * 60_000;

const HOUR_MS = 60 * 60 * 1000;

/** Owns the reader, the rescan cadence, and snapshot assembly for the UI. */
export class UsageService {
  private reader = new UsageReader();
  private tier: PlanTier = 'auto';
  private customCeilings: { sessionTokens: number; weeklyTokens: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private real: RealUsage | null = null;
  /** The session a `/cost` fetch is armed for, or null when none is in flight. */
  private pendingReal: { sessionId: string; armedAt: number } | null = null;

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

  setCustomCeilings(c: { sessionTokens: number; weeklyTokens: number }): void {
    this.customCeilings = c;
    this.onChange();
  }

  /**
   * Arms capture of the next assistant reply from `sessionId` as real plan
   * usage, then runs `sendCost` (the caller's `session.sendPrompt('/cost')`).
   * Sending is the caller's job, not this service's, so this file never
   * touches a session directly — it only knows the shape of the reply.
   */
  requestReal(sessionId: string, sendCost: () => void, now = Date.now()): void {
    this.pendingReal = { sessionId, armedAt: now };
    sendCost();
    this.onChange();
  }

  /**
   * Every transcript item flows through here; only the one this is armed for
   * matters.
   *
   * The arm survives a reply that does not parse. Clearing on the first
   * assistant message sounds right — a `/cost` reply is exactly one message —
   * but it fails whenever the target session was mid-turn: the prompt queues
   * behind the running turn, that turn's own reply arrives first and consumes
   * the arm, and the real answer lands with nothing listening. The user sees
   * the button finish and no data appear.
   *
   * Waiting for a reply that actually parses is safe because the shape being
   * matched is highly specific ("Current session: N% used · resets …") — no
   * ordinary reply looks like that. ARMED_TTL_MS bounds the wait so a `/cost`
   * that never answers cannot leave the arm live indefinitely.
   */
  captureReal(sessionId: string, item: TranscriptItem, now = Date.now()): void {
    const armed = this.armedFor(sessionId, now);
    if (!armed || item.kind !== 'assistant') return;
    const windows = parseCostReply(item.text);
    if (windows.length === 0) return; // an unrelated reply; keep waiting
    this.pendingReal = null;
    this.real = { windows, fetchedAt: now, sessionId };
    this.onChange();
  }

  /** True while this session's `/cost` answer is still worth waiting for. */
  private armedFor(sessionId: string, now: number): boolean {
    const p = this.pendingReal;
    if (!p || p.sessionId !== sessionId) return false;
    if (now - p.armedAt > ARMED_TTL_MS) {
      this.pendingReal = null;
      return false;
    }
    return true;
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
      real: this.real,
      realPending: this.pendingReal !== null && now - this.pendingReal.armedAt <= ARMED_TTL_MS,
    };
  }

  private reference(now: number): Reference | null {
    if (this.tier === 'custom' && this.customCeilings) return referenceFromCustom(this.customCeilings);
    if (this.tier !== 'auto' && this.tier !== 'custom') return referenceFromTier(this.tier);
    // 'auto', or 'custom' with nothing set yet — fall back to the same
    // history-derived baseline as the default tier.
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
