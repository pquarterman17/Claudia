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

/**
 * Which sessions to stop when no page is watching any more.
 *
 * Already-stopped ones are not stopped again, and sessions belonging to a
 * running cross-agent exchange are exempt: a debate is started precisely so it
 * can run while nobody watches, and stopping one mid-argument is the single
 * case where this rule does the opposite of its purpose. Observed live before
 * the exemption existed — both sessions were killed between the review and the
 * rebuttal, and the exchange reported that the author "said nothing".
 *
 * Pure so the exemption is testable without a socket, a timer or an agent.
 */
export function sessionsToStop(
  sessions: ReadonlyArray<{ id: string; state: string }>,
  busy: ReadonlySet<string>,
): string[] {
  return sessions.filter((s) => s.state !== 'stopped' && !busy.has(s.id)).map((s) => s.id);
}
