import type { FinishActionKey, HostPlatform, SessionSummary, TriggerState, TriggerStatus } from '@claudia/shared';
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
  execute: (key: FinishActionKey, platform: HostPlatform) => Promise<string>;
  onChange: () => void;
  countdownSec?: number;
}

/**
 * Arms a finish action and fires it once every session has settled.
 *
 * Deliberately conservative: any session that needs a human holds the trigger
 * and cancels an in-flight countdown, firing disarms (one-shot), and a
 * destructive action cannot be armed without an explicit confirmation.
 */
export class TriggerEngine {
  private state: TriggerState = 'disarmed';
  private action: FinishActionKey = 'notify';
  private countdown: number | undefined;
  private firedAt: number | undefined;
  private lastResult: string | undefined;
  private blocked: string | null = null;
  private readonly countdownSec: number;

  constructor(private readonly opts: TriggerEngineOptions) {
    this.countdownSec = opts.countdownSec ?? DEFAULT_COUNTDOWN_SEC;
  }

  status(): TriggerStatus {
    const spec = specFor(this.action);
    return {
      state: this.state,
      action: this.action,
      command: describeCommand(this.action, this.opts.platform),
      destructive: spec.destructive,
      ...(this.countdown !== undefined ? { countdownSec: this.countdown } : {}),
      ...(this.blocked ? { blockedBy: this.blocked } : {}),
      ...(this.firedAt !== undefined ? { firedAt: this.firedAt } : {}),
      ...(this.lastResult ? { lastResult: this.lastResult } : {}),
    };
  }

  selectAction(action: FinishActionKey): void {
    specFor(action); // validates
    this.action = action;
    // Changing the action clears a spent trigger, and disarms a live one so a
    // countdown can never carry over onto a different (possibly destructive) action.
    this.state = 'disarmed';
    this.countdown = undefined;
    this.firedAt = undefined;
    this.lastResult = undefined;
    this.opts.onChange();
  }

  arm(confirmDestructive = false): void {
    const spec = specFor(this.action);
    if (spec.destructive && !confirmDestructive) {
      throw new Error(`${spec.label} is destructive — confirm before arming`);
    }
    this.state = 'armed';
    this.countdown = undefined;
    this.firedAt = undefined;
    this.lastResult = undefined;
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
        if (this.countdown === 0) void this.fire();
      }
    }

    if (JSON.stringify(this.status()) !== before) this.opts.onChange();
  }

  private async fire(): Promise<void> {
    const action = this.action;
    // Disarm before running: one-shot, and a slow command must not fire twice.
    this.state = 'fired';
    this.countdown = undefined;
    this.firedAt = Date.now();
    this.opts.onChange();
    try {
      this.lastResult = await this.opts.execute(action, this.opts.platform);
    } catch (err) {
      this.lastResult = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this.opts.onChange();
  }
}
