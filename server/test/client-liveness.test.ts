import { describe, expect, it } from 'vitest';
import { sessionsToStop, isClientLive, WS_OPEN } from '../src/client-liveness.js';

const NOW = 1_000_000;
const CLOSED = 3;
const CONNECTING = 0;

describe('isClientLive', () => {
  it('counts a socket that is beating', () => {
    expect(isClientLive(WS_OPEN, NOW - 1_000, NOW, 20_000)).toBe(true);
  });

  it('does NOT count an open socket that stopped beating', () => {
    // The case that broke this in practice: Firefox kept a navigated-away page
    // and its WebSocket alive in the back/forward cache, so the socket read as
    // open forever and sessions were never stopped.
    expect(isClientLive(WS_OPEN, NOW - 60_000, NOW, 20_000)).toBe(false);
  });

  it('gives a freshly connected socket the benefit of the doubt', () => {
    expect(isClientLive(WS_OPEN, undefined, NOW, 20_000)).toBe(true);
  });

  it('ignores sockets that are not open', () => {
    expect(isClientLive(CLOSED, NOW, NOW, 20_000)).toBe(false);
    expect(isClientLive(CONNECTING, NOW, NOW, 20_000)).toBe(false);
  });

  it('treats exactly-at-the-threshold as stale, not live', () => {
    expect(isClientLive(WS_OPEN, NOW - 20_000, NOW, 20_000)).toBe(false);
    expect(isClientLive(WS_OPEN, NOW - 19_999, NOW, 20_000)).toBe(true);
  });

  it('tolerates a clock that jumped backwards', () => {
    expect(isClientLive(WS_OPEN, NOW + 5_000, NOW, 20_000)).toBe(true);
  });
});

describe('sessionsToStop', () => {
  const sessions = [
    { id: 'a', state: 'working' },
    { id: 'b', state: 'idle' },
    { id: 'gone', state: 'stopped' },
  ];

  it('stops the live ones when nothing is watching', () => {
    expect(sessionsToStop(sessions, new Set())).toEqual(['a', 'b']);
  });

  it('never re-stops one that is already stopped', () => {
    expect(sessionsToStop(sessions, new Set())).not.toContain('gone');
  });

  it('spares sessions that are mid-debate', () => {
    // The case this exists for, and it was observed live: a cross-agent
    // exchange runs for minutes with nobody watching — that is the point of
    // it — and the idle-stop killed both sessions between the review and the
    // rebuttal, so the exchange reported that the author "said nothing".
    expect(sessionsToStop(sessions, new Set(['a']))).toEqual(['b']);
    expect(sessionsToStop(sessions, new Set(['a', 'b']))).toEqual([]);
  });
});
