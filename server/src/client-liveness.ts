import { CLIENT_STALE_MS } from '@claudia/shared';

/** WebSocket.OPEN, without importing ws into a pure module. */
export const WS_OPEN = 1;

/**
 * Is a real page still behind this socket?
 *
 * An open socket is not proof. Firefox keeps a navigated-away page and its
 * WebSocket alive in the back/forward cache, and a sleeping laptop leaves
 * half-open sockets behind — in both cases TCP looks fine while nobody is
 * watching. A frozen page stops running timers, so the absence of heartbeats
 * is the signal that actually distinguishes them.
 *
 * A socket that has not spoken yet is treated as live: it has just connected
 * and has not had time to beat.
 */
export function isClientLive(
  readyState: number,
  lastSeen: number | undefined,
  now: number,
  staleMs: number = CLIENT_STALE_MS,
): boolean {
  if (readyState !== WS_OPEN) return false;
  if (lastSeen === undefined) return true;
  return now - lastSeen < staleMs;
}
