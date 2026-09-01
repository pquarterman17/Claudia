import type { SessionState, SessionSummary } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { TriggerEngine, blockingReason } from '../src/trigger-engine.js';

function session(state: SessionState): SessionSummary {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'x',
    cwd: '/x',
    permissionMode: 'default',
    effortLevel: 'medium',
    thinkingMode: 'adaptive',
    contextPending: false,
    todos: [],
    state,
    startedAt: 0,
    lastActivityAt: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    modelUsage: [],
    queuedPrompts: [],
  };
}

function engine(countdownSec = 3, chain: Parameters<TriggerEngine['setChain']>[0] = ['notify']) {
  const execute = vi.fn(async () => 'ok');
  const e = new TriggerEngine({
    platform: 'darwin',
    execute,
    onChange: () => undefined,
    countdownSec,
  });
  e.setChain(chain);
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

  it('holds for a session that asked the user a question', () => {
    // The dangerous case: a session waiting on an answer reports 'idle', so
    // without this the chain would shut the machine down mid-conversation.
    const asking = {
      ...session('idle'),
      needsAction: { request: 'tabs or spaces?', since: 0 },
    };
    expect(blockingReason([asking])).toContain('waiting on your answer');
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

  it('refuses to arm a chain containing a destructive step', () => {
    const { e } = engine(3, ['notify', 'shutdown']);
    expect(() => e.arm()).toThrow(/destructive/i);
    expect(e.status().state).toBe('disarmed');
    expect(() => e.arm(true)).not.toThrow();
    expect(e.status().state).toBe('armed');
  });

  it('refuses to arm an empty chain', () => {
    const { e } = engine(3, []);
    expect(() => e.arm()).toThrow(/at least one/i);
  });

  it('editing the chain disarms, so a countdown cannot carry onto new steps', () => {
    const { e } = engine();
    e.arm();
    e.tick([session('idle')]);
    expect(e.status().state).toBe('counting');

    e.toggleAction('shutdown');
    expect(e.status().state).toBe('disarmed');
    expect(e.status().countdownSec).toBeUndefined();
  });

  it('surfaces a failed action instead of reporting success', async () => {
    const execute = vi.fn(async () => {
      throw new Error('pmset not found');
    });
    const e = new TriggerEngine({ platform: 'darwin', execute, onChange: () => undefined, countdownSec: 1 });
    e.setChain(['sleep']);
    e.arm();
    settle(e, [session('idle')], 5);
    // The failure surfaces on the step, and the summary says where it stopped.
    await vi.waitFor(() => expect(e.status().chain[0]?.detail).toContain('pmset not found'));
    expect(e.status().chain[0]?.state).toBe('failed');
    expect(e.status().lastResult).toMatch(/stopped at/i);
    expect(e.status().state).toBe('fired');
  });

  it('reports the real per-OS command for each step', () => {
    const { e } = engine(3, ['sleep']);
    expect(e.status().chain[0]?.command).toContain('pmset');

    const win = new TriggerEngine({
      platform: 'win32',
      execute: async () => 'ok',
      onChange: () => undefined,
    });
    win.setChain(['sleep']);
    expect(win.status().chain[0]?.command).toContain('LockWorkStation');
  });
});

describe('TriggerEngine chains', () => {
  it('toggles actions on and off, preserving click order', () => {
    const { e } = engine(3, []);
    e.toggleAction('memory');
    e.toggleAction('notify');
    expect(e.actions).toEqual(['memory', 'notify']);

    e.toggleAction('memory');
    expect(e.actions).toEqual(['notify']);
  });

  it('runs every step in order when each succeeds', async () => {
    const order: string[] = [];
    const execute = vi.fn(async (key: string) => {
      order.push(key);
      return `did ${key}`;
    });
    const e = new TriggerEngine({ platform: 'darwin', execute, onChange: () => undefined, countdownSec: 1 });
    e.setChain(['memory', 'notify', 'sleep']);
    e.arm();

    e.tick([session('idle')]);
    e.tick([session('idle')]);
    await vi.waitFor(() => expect(e.status().state).toBe('fired'));

    expect(order).toEqual(['memory', 'notify', 'sleep']);
    expect(e.status().chain.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(e.status().lastResult).toMatch(/All 3 steps completed/);
  });

  it('starts a step only after the previous one resolves', async () => {
    // The core promise of a chain: no overlap, so "shut down" cannot begin
    // while "commit + push" is still running.
    let running = 0;
    let maxConcurrent = 0;
    const execute = vi.fn(async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return 'ok';
    });
    const e = new TriggerEngine({ platform: 'darwin', execute, onChange: () => undefined, countdownSec: 1 });
    e.setChain(['memory', 'notify', 'sleep']);
    e.arm();
    e.tick([session('idle')]);
    e.tick([session('idle')]);

    await vi.waitFor(() => expect(e.status().state).toBe('fired'), { timeout: 3000 });
    expect(maxConcurrent).toBe(1);
  });

  it('stops at the first failure and skips the rest', async () => {
    // The safety property: a failed push must not be followed by a shutdown.
    const execute = vi.fn(async (key: string) => {
      if (key === 'notify') throw new Error('notifier missing');
      return 'ok';
    });
    const e = new TriggerEngine({ platform: 'darwin', execute, onChange: () => undefined, countdownSec: 1 });
    e.setChain(['memory', 'notify', 'shutdown']);
    e.arm(true);

    e.tick([session('idle')]);
    e.tick([session('idle')]);
    await vi.waitFor(() => expect(e.status().state).toBe('fired'));

    const states = e.status().chain.map((s) => s.state);
    expect(states).toEqual(['done', 'failed', 'skipped']);
    expect(execute).not.toHaveBeenCalledWith('shutdown');
    expect(e.status().chain[1]?.detail).toContain('notifier missing');
    expect(e.status().lastResult).toMatch(/stopped at/i);
  });

  it('records a duration for every step it attempted', async () => {
    const { e } = engine(1, ['notify', 'sleep']);
    e.arm();
    e.tick([session('idle')]);
    e.tick([session('idle')]);
    await vi.waitFor(() => expect(e.status().state).toBe('fired'));
    for (const step of e.status().chain) expect(step.durMs).toBeGreaterThanOrEqual(0);
  });

  it('reports destructive if any step is, not just the last', () => {
    const { e } = engine(3, ['shutdown', 'notify']);
    expect(e.status().destructive).toBe(true);
  });
});

describe('TriggerEngine.moveAction', () => {
  it('move down swaps the action with its next neighbor', () => {
    const { e } = engine(3, ['memory', 'notify', 'sleep']);
    e.moveAction('memory', 'down');
    expect(e.actions).toEqual(['notify', 'memory', 'sleep']);
  });

  it('move up swaps the action with its previous neighbor', () => {
    const { e } = engine(3, ['memory', 'notify', 'sleep']);
    e.moveAction('sleep', 'up');
    expect(e.actions).toEqual(['memory', 'sleep', 'notify']);
  });

  it('moving up at index 0 is a no-op and does not disarm', () => {
    const { e } = engine(3, ['memory', 'notify']);
    e.arm();
    e.tick([session('idle')]);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });

    e.moveAction('memory', 'up');
    expect(e.actions).toEqual(['memory', 'notify']);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });
  });

  it('moving down at the last index is a no-op and does not disarm', () => {
    const { e } = engine(3, ['memory', 'notify']);
    e.arm();
    e.tick([session('idle')]);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });

    e.moveAction('notify', 'down');
    expect(e.actions).toEqual(['memory', 'notify']);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });
  });

  it('an action not in the chain is a no-op', () => {
    const { e } = engine(3, ['memory', 'notify']);
    e.arm();
    e.tick([session('idle')]);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });

    e.moveAction('shutdown', 'up');
    expect(e.actions).toEqual(['memory', 'notify']);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 3 });
  });

  it('a real move mid-countdown disarms, so a countdown never carries onto a different order', () => {
    const { e } = engine(5, ['memory', 'notify', 'sleep']);
    e.arm();
    e.tick([session('idle')]);
    expect(e.status()).toMatchObject({ state: 'counting', countdownSec: 5 });

    e.moveAction('memory', 'down');
    expect(e.actions).toEqual(['notify', 'memory', 'sleep']);
    expect(e.status().state).toBe('disarmed');
    expect(e.status().countdownSec).toBeUndefined();
  });
});
