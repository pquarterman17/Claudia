import type { SessionState, SessionSummary } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { TriggerEngine, blockingReason } from '../src/trigger-engine.js';

function session(state: SessionState): SessionSummary {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'x',
    cwd: '/x',
    permissionMode: 'default',
    state,
    startedAt: 0,
    lastActivityAt: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
  };
}

function engine(countdownSec = 3) {
  const execute = vi.fn(async () => 'ok');
  const e = new TriggerEngine({
    platform: 'darwin',
    execute,
    onChange: () => undefined,
    countdownSec,
  });
  return { e, execute };
}

const settle = (e: TriggerEngine, sessions: SessionSummary[], n: number) => {
  for (let i = 0; i < n; i++) e.tick(sessions);
};

describe('blockingReason', () => {
  it('holds when there are no sessions at all', () => {
    // Guard: an empty app must never fire a shutdown.
    expect(blockingReason([])).toBe('no sessions to wait for');
  });

  it('clears when every session is idle or stopped', () => {
    expect(blockingReason([session('idle'), session('stopped')])).toBeNull();
  });

  it.each([
    ['awaiting_approval' as const, 'awaiting approval'],
    ['error' as const, 'blocked on an error'],
    ['working' as const, 'still working'],
    ['starting' as const, 'still working'],
  ])('holds on a %s session', (state, expected) => {
    expect(blockingReason([session('idle'), session(state)])).toContain(expected);
  });

  it('reports what needs a human before what is merely slow', () => {
    const sessions = [session('working'), session('error'), session('awaiting_approval')];
    expect(blockingReason(sessions)).toContain('awaiting approval');
    expect(blockingReason([session('working'), session('error')])).toContain('error');
  });

  it('pluralises', () => {
    expect(blockingReason([session('working')])).toBe('1 session still working');
    expect(blockingReason([session('working'), session('working')])).toBe('2 sessions still working');
  });
});

describe('TriggerEngine', () => {
  it('starts disarmed and fires nothing', () => {
    const { e, execute } = engine();
    expect(e.status().state).toBe('disarmed');
    settle(e, [session('idle')], 10);
    expect(execute).not.toHaveBeenCalled();
  });

  it('counts down and fires once everything is settled', async () => {
    const { e, execute } = engine(3);
    e.arm();
    const idle = [session('idle')];

    e.tick(idle);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });
    e.tick(idle);
    e.tick(idle);
    expect(execute).not.toHaveBeenCalled();
    e.tick(idle); // hits zero
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(e.status().state).toBe('fired');
  });

  it('holds while a session is busy, then fires when it settles', async () => {
    const { e, execute } = engine(2);
    e.arm();
    const busy = [session('working')];

    settle(e, busy, 5);
    expect(e.status().state).toBe('armed');
    expect(e.status().blockedBy).toContain('still working');
    expect(execute).not.toHaveBeenCalled();

    const idle = [session('idle')];
    settle(e, idle, 3);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  });

  it('a session needing approval mid-countdown cancels it', async () => {
    const { e, execute } = engine(5);
    e.arm();
    const idle = [session('idle')];
    e.tick(idle);
    e.tick(idle);
    expect(e.status().countdownSec).toBe(4);

    // Someone hits a permission prompt — the countdown must abandon, not pause.
    e.tick([session('awaiting_approval')]);
    expect(e.status().state).toBe('armed');
    expect(e.status().countdownSec).toBeUndefined();

    // And it restarts from full, not from where it left off.
    e.tick(idle);
    expect(e.status().countdownSec).toBe(5);
    expect(execute).not.toHaveBeenCalled();
  });

  it('fires only once (one-shot)', async () => {
    const { e, execute } = engine(1);
    e.arm();
    const idle = [session('idle')];
    settle(e, idle, 10);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    settle(e, idle, 10);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('disarming mid-countdown prevents firing', async () => {
    const { e, execute } = engine(3);
    e.arm();
    const idle = [session('idle')];
    e.tick(idle);
    e.disarm();
    settle(e, idle, 10);
    expect(execute).not.toHaveBeenCalled();
    expect(e.status().state).toBe('disarmed');
  });

  it('refuses to arm a destructive action without confirmation', () => {
    const { e } = engine();
    e.selectAction('shutdown');
    expect(() => e.arm()).toThrow(/destructive/i);
    expect(e.status().state).toBe('disarmed');
    expect(() => e.arm(true)).not.toThrow();
    expect(e.status().state).toBe('armed');
  });

  it('changing the action disarms, so a countdown cannot carry onto shutdown', () => {
    const { e } = engine();
    e.arm();
    e.tick([session('idle')]);
    expect(e.status().state).toBe('counting');

    e.selectAction('shutdown');
    expect(e.status().state).toBe('disarmed');
    expect(e.status().countdownSec).toBeUndefined();
  });

  it('surfaces a failed action instead of reporting success', async () => {
    const execute = vi.fn(async () => {
      throw new Error('pmset not found');
    });
    const e = new TriggerEngine({ platform: 'darwin', execute, onChange: () => undefined, countdownSec: 1 });
    e.arm();
    settle(e, [session('idle')], 5);
    await vi.waitFor(() => expect(e.status().lastResult).toContain('pmset not found'));
    expect(e.status().state).toBe('fired');
  });

  it('reports the real per-OS command', () => {
    const { e } = engine();
    e.selectAction('sleep');
    expect(e.status().command).toContain('pmset');
    const win = new TriggerEngine({
      platform: 'win32',
      execute: async () => 'ok',
      onChange: () => undefined,
    });
    win.selectAction('sleep');
    expect(win.status().command).toContain('LockWorkStation');
  });
});
