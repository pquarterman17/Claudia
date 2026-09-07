import type { SessionSummary } from '@claudia/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionReaper } from '../src/session-reaper.js';

/**
 * Closing sessions once the last browser goes away.
 *
 * The property that matters most here is the one that is hardest to see: a
 * RELOAD must not lose your work. The reaper only ever acts on a timer, and a
 * page coming back cancels it — so these tests drive the clock rather than the
 * browser, which is also the only way to test it at all. (The end-to-end check
 * is not reproducible in every environment: a browser that takes longer to
 * reconnect than the grace allows will lose the race no matter what the code
 * does, which is exactly why the window is a named constant.)
 */

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: 's1', state: 'idle', ...over }) as SessionSummary;

function reaper(over: { graceSec?: number; sessions?: SessionSummary[] } = {}) {
  const removed: string[] = [];
  let live = 0;
  const r = new SessionReaper({
    liveClients: () => live,
    graceSec: () => over.graceSec ?? 30,
    orchestrated: () => new Set(),
    fleet: () => undefined,
    summaries: () => over.sessions ?? [session()],
    remove: (id) => removed.push(id),
  });
  return { r, removed, setLive: (n: number) => (live = n) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SessionReaper', () => {
  it('closes sessions after the configured wait when the browser vanishes', () => {
    const { r, removed } = reaper();
    r.check();
    vi.advanceTimersByTime(29_999);
    expect(removed).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(removed).toEqual(['s1']);
  });

  it('closes them promptly when the page said it was unloading', () => {
    const { r, removed } = reaper();
    r.announceClosing();
    r.check();
    vi.advanceTimersByTime(3_100);
    expect(removed).toEqual(['s1']);
  });

  it('does NOT close them when a reload comes back inside that window', () => {
    // The whole reason a grace period exists. An announcement shortens the
    // wait; it must never remove the reprieve.
    const { r, removed, setLive } = reaper();
    r.announceClosing();
    r.check();
    vi.advanceTimersByTime(1_000);
    setLive(1);
    r.check(); // the reloaded page reconnects
    vi.advanceTimersByTime(60_000);
    expect(removed).toEqual([]);
  });

  it('forgets the announcement once a page is back, so a later drop waits in full', () => {
    // Otherwise a reload would leave the fleet on a hair trigger: the next
    // network blip, hours later, would close everything in three seconds.
    const { r, removed, setLive } = reaper();
    r.announceClosing();
    r.check();
    setLive(1);
    r.check();
    setLive(0);
    r.check();
    vi.advanceTimersByTime(4_000);
    expect(removed).toEqual([]);
    vi.advanceTimersByTime(27_000);
    expect(removed).toEqual(['s1']);
  });

  it('never closes anything when the setting is zero', () => {
    const { r, removed } = reaper({ graceSec: 0 });
    r.announceClosing();
    r.check();
    vi.advanceTimersByTime(600_000);
    expect(removed).toEqual([]);
  });

  it('leaves a session that is already stopped alone', () => {
    const { r, removed } = reaper({ sessions: [session({ state: 'stopped' })] });
    r.check();
    vi.advanceTimersByTime(31_000);
    expect(removed).toEqual([]);
  });

  it('does not stack timers when several sockets close at once', () => {
    const { r, removed } = reaper();
    r.check();
    r.check();
    r.check();
    vi.advanceTimersByTime(31_000);
    expect(removed).toEqual(['s1']);
  });
});
