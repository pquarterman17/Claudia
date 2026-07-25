import type {
  ChainStep,
  FinishActionKey,
  HostPlatform,
  SessionSummary,
  StepState,
  TriggerState,
  TriggerStatus,
} from '@claudia/shared';
import { describeCommand, specFor } from './finish-actions.js';

export const DEFAULT_COUNTDOWN_SEC = 30;

/**
 * Why the trigger must not fire yet, or null if everything is settled.
 *
 * Pure and exported so the hold rules are testable without a live session.
 * Order is deliberate: things needing a human are reported before things that
 * are merely slow, because that is what the operator has to act on.
 */
export function blockingReason(sessions: SessionSummary[]): string | null {
  if (sessions.length === 0) return 'no sessions to wait for';

  const count = (...states: SessionSummary['state'][]) =>
    sessions.filter((s) => states.includes(s.state)).length;
  const plural = (n: number) => (n === 1 ? 'session' : 'sessions');

  const waiting = count('awaiting_approval');
  if (waiting) return `${waiting} ${plural(waiting)} awaiting approval`;

  const errored = count('error');
  if (errored) return `${errored} ${plural(errored)} blocked on an error`;

  const busy = count('working', 'starting');
  if (busy) return `${busy} ${plural(busy)} still working`;

  return null;
}

export interface TriggerEngineOptions {
  platform: HostPlatform;
  execute: (key: FinishActionKey) => Promise<string>;
  onChange: () => void;
  countdownSec?: number;
}

interface Link {
  key: FinishActionKey;
  state: StepState;
  detail?: string;
  durMs?: number;
}

/**
 * Runs an ordered chain of finish actions once every session has settled.
 *
 * Steps run strictly in sequence, each starting only when the previous one
 * reports success. A failure stops the chain and leaves the rest 'skipped' —
 * that ordering is the safety property: if "commit + push" fails, "shut down"
 * must not run and quietly lose the work.
 *
 * Conservative elsewhere too: any session needing a human holds the trigger and
 * cancels an in-flight countdown, firing disarms (one-shot), and a chain
 * containing a destructive step cannot be armed without explicit confirmation.
 */
export class TriggerEngine {
  private state: TriggerState = 'disarmed';
  private chain: Link[] = [];
  private countdown: number | undefined;
  private firedAt: number | undefined;
  private lastResult: string | undefined;
  private blocked: string | null = null;
  private countdownSec: number;

  constructor(private readonly opts: TriggerEngineOptions) {
    this.countdownSec = opts.countdownSec ?? DEFAULT_COUNTDOWN_SEC;
  }

  status(): TriggerStatus {
    return {
      state: this.state,
      chain: this.chain.map(
        (l): ChainStep => ({
          key: l.key,
          state: l.state,
          command: describeCommand(l.key, this.opts.platform),
          destructive: specFor(l.key).destructive,
          ...(l.detail ? { detail: l.detail } : {}),
          ...(l.durMs !== undefined ? { durMs: l.durMs } : {}),
        }),
      ),
      destructive: this.chain.some((l) => specFor(l.key).destructive),
      ...(this.countdown !== undefined ? { countdownSec: this.countdown } : {}),
      ...(this.blocked ? { blockedBy: this.blocked } : {}),
      ...(this.firedAt !== undefined ? { firedAt: this.firedAt } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
    };
  }

  /** Appends the action, or removes it if already in the chain. */
  toggleAction(action: FinishActionKey): void {
    specFor(action); // validates
    const existing = this.chain.findIndex((l) => l.key === action);
    this.chain =
      existing >= 0
        ? this.chain.filter((_, i) => i !== existing)
        : [...this.chain, { key: action, state: 'pending' as StepState }];
    this.resetRun();
  }

  setChain(actions: FinishActionKey[]): void {
    this.chain = actions.map((key) => ({ key, state: 'pending' as StepState }));
    this.resetRun();
  }

  clearChain(): void {
    this.chain = [];
    this.resetRun();
  }

  get actions(): FinishActionKey[] {
    return this.chain.map((l) => l.key);
  }

  /**
   * Editing the chain always disarms. Otherwise a countdown started against one
   * set of steps could fire against a different, possibly destructive, set.
   */
  private resetRun(): void {
    this.state = 'disarmed';
    this.countdown = undefined;
    this.firedAt = undefined;
    this.lastResult = undefined;
    for (const link of this.chain) {
      link.state = 'pending';
      delete link.detail;
      delete link.durMs;
    }
    this.opts.onChange();
  }

  /** Clamped: under 5s there is no realistic chance to cancel a shutdown. */
  setCountdown(seconds: number): void {
    this.countdownSec = Math.max(5, Math.min(600, Math.round(seconds)));
    if (this.state === 'counting') {
      this.state = 'armed';
      this.countdown = undefined;
    }
    this.opts.onChange();
  }

  get countdownLength(): number {
    return this.countdownSec;
  }

  arm(confirmDestructive = false): void {
    if (this.chain.length === 0) throw new Error('Add at least one action before arming');
    const destructive = this.chain.filter((l) => specFor(l.key).destructive);
    if (destructive.length > 0 && !confirmDestructive) {
      const labels = destructive.map((l) => specFor(l.key).label).join(', ');
      throw new Error(`${labels} is destructive — confirm before arming`);
    }
    this.state = 'armed';
    this.countdown = undefined;
    this.firedAt = undefined;
    this.lastResult = undefined;
    for (const link of this.chain) {
      link.state = 'pending';
      delete link.detail;
      delete link.durMs;
    }
    this.opts.onChange();
  }

  disarm(): void {
    this.state = 'disarmed';
    this.countdown = undefined;
    this.opts.onChange();
  }

  /** Call once a second with the current sessions. Fires when due. */
  tick(sessions: SessionSummary[]): void {
    const before = JSON.stringify(this.status());
    this.blocked = blockingReason(sessions);

    if (this.state === 'armed' || this.state === 'counting') {
      if (this.blocked) {
        // Something needs a human — hold, and abandon any countdown in flight.
        this.state = 'armed';
        this.countdown = undefined;
      } else if (this.state === 'armed') {
        this.state = 'counting';
        this.countdown = this.countdownSec;
      } else if (this.countdown !== undefined && this.countdown > 0) {
        this.countdown -= 1;
        if (this.countdown === 0) void this.runChain();
      }
    }

    if (JSON.stringify(this.status()) !== before) this.opts.onChange();
  }

  /**
   * Runs the chain in order. Once started it is not interrupted by sessions
   * becoming busy again — a half-run chain (pushed but not released) is worse
   * than a completed one.
   */
  private async runChain(): Promise<void> {
    this.state = 'running';
    this.countdown = undefined;
    this.firedAt = Date.now();
    this.opts.onChange();

    let completed = 0;
    let stoppedAt: string | undefined;

    for (const link of this.chain) {
      if (stoppedAt) {
        link.state = 'skipped';
        continue;
      }
      link.state = 'running';
      this.opts.onChange();
      const startedAt = Date.now();
      try {
        link.detail = await this.opts.execute(link.key);
        link.state = 'done';
        completed++;
      } catch (err) {
        link.state = 'failed';
        link.detail = err instanceof Error ? err.message : String(err);
        stoppedAt = specFor(link.key).label;
      }
      link.durMs = Date.now() - startedAt;
      this.opts.onChange();
    }

    this.state = 'fired';
    this.lastResult = stoppedAt
      ? `${completed} of ${this.chain.length} steps — stopped at ${stoppedAt}`
      : `All ${this.chain.length} step${this.chain.length === 1 ? '' : 's'} completed`;
    this.opts.onChange();
  }
}
