import { describe, expect, it } from 'vitest';
import { isClientLive, WS_OPEN } from '../src/client-liveness.js';

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
