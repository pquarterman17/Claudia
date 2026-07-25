import type { SessionState, SessionSummary } from '@claudia/shared';
import { describe, expect, it, vi } from 'vitest';
import { TriggerEngine } from '../src/trigger-engine.js';

function session(state: SessionState): SessionSummary {
  return {
    id: 'x',
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

function engine() {
  const execute = vi.fn(async () => 'ok');
  return {
    execute,
    e: (() => { const t = new TriggerEngine({ platform: 'darwin', execute, onChange: () => undefined, countdownSec: 30 }); t.setChain(['notify']); return t; })(),
  };
}

describe('configurable countdown', () => {
  it('uses the configured length', () => {
    const { e } = engine();
    e.setCountdown(7);
    e.arm();
    e.tick([session('idle')]);
    expect(e.status().countdownSec).toBe(7);
  });

  it('refuses a countdown too short to cancel a shutdown', () => {
    const { e } = engine();
    e.setCountdown(0);
    expect(e.countdownLength).toBe(5);
    e.setCountdown(-100);
    expect(e.countdownLength).toBe(5);
  });

  it('caps absurdly long countdowns', () => {
    const { e } = engine();
    e.setCountdown(99_999);
    expect(e.countdownLength).toBe(600);
  });

  it('rounds fractional input', () => {
    const { e } = engine();
    e.setCountdown(12.6);
    expect(e.countdownLength).toBe(13);
  });

  it('changing the length mid-countdown restarts rather than firing early', () => {
    const { e, execute } = engine();
    e.setCountdown(30);
    e.arm();
    e.tick([session('idle')]);
    expect(e.status().state).toBe('counting');

    e.setCountdown(6);
    expect(e.status().state).toBe('armed');
    expect(e.status().countdownSec).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});
