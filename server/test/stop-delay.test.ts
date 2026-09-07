import { describe, expect, it } from 'vitest';
import { RELOAD_GRACE_MS, stopDelayMs } from '../src/client-liveness.js';

/**
 * How long sessions survive the browser going away.
 *
 * The grace exists because a dropped socket is ambiguous: a closed tab, a
 * sleeping laptop and a page the browser froze all look identical from the
 * server. A page that ANNOUNCES it is unloading removes that ambiguity and
 * leaves one question — does a reload come back? — which is answered in well
 * under a second on the same machine.
 */

const NOW = 1_000_000;

describe('stopDelayMs', () => {
  it('waits the configured time when the browser just vanished', () => {
    expect(stopDelayMs(30, undefined, NOW)).toBe(30_000);
  });

  it('waits only for a reload when the page said it was unloading', () => {
    expect(stopDelayMs(30, NOW - 100, NOW)).toBe(RELOAD_GRACE_MS);
  });

  it('never waits longer than the setting asks for', () => {
    // Somebody who asked for one second asked for one second. An announcement
    // is a reason to act sooner, not a licence to act later.
    expect(stopDelayMs(1, NOW - 100, NOW)).toBe(1_000);
  });

  it('ignores an announcement too old to be about this socket', () => {
    // A page that said goodbye, was reloaded, and ran for a minute before the
    // network dropped is the ambiguous case again.
    expect(stopDelayMs(30, NOW - 60_000, NOW)).toBe(30_000);
  });

  it('never stops sessions when the setting is zero', () => {
    expect(stopDelayMs(0, undefined, NOW)).toBeUndefined();
    expect(stopDelayMs(0, NOW - 100, NOW)).toBeUndefined();
  });

  it('treats an unreadable setting as disabled rather than as no wait at all', () => {
    // `NaN * 1000` is NaN, and `setTimeout(fn, NaN)` fires immediately — which
    // would stop every session the instant a socket closed.
    expect(stopDelayMs(Number.NaN, undefined, NOW)).toBeUndefined();
    expect(stopDelayMs(Number.POSITIVE_INFINITY, undefined, NOW)).toBeUndefined();
    expect(stopDelayMs(-5, undefined, NOW)).toBeUndefined();
  });
});
