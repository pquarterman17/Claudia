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
/**
 * Sessions that must survive the browser going away.
 *
 * Orchestrator-owned ones were always exempt. Fleet children were not, and the
 * omission was only visible once a launcher existed: a mission dispatched a
 * task, the child started, the tab closed, and thirty seconds later the reaper
 * stopped the very work the fleet had just paid to begin. Unattended is what a
 * fleet IS — the pulse keeps deciding with nobody watching, and a child it
 * started is no more abandoned than the mission that wanted it.
 *
 * Read from the STORE rather than from a set kept in memory, so a run adopted
 * across a restart counts too: those rows outlive the process, and an in-memory
 * set would forget them exactly when recovery had just remembered.
 */
export function busySessionIds(
  orchestrated: ReadonlySet<string>,
  fleet: { runs: { listActive(): { ok: boolean; value?: Array<{ sessionId?: string }> } } } | undefined,
): ReadonlySet<string> {
  const busy = new Set(orchestrated);
  const active = fleet?.runs.listActive();
  if (active?.ok) {
    for (const run of active.value ?? []) if (run.sessionId) busy.add(run.sessionId);
  }
  return busy;
}

export function sessionsToStop(
  sessions: ReadonlyArray<{ id: string; state: string }>,
  busy: ReadonlySet<string>,
): string[] {
  return sessions.filter((s) => s.state !== 'stopped' && !busy.has(s.id)).map((s) => s.id);
}

/**
 * How long a reload has to come back before sessions are stopped.
 *
 * Only reached when a page ANNOUNCED it was unloading, which is the whole
 * point: without that, a dropped socket might be a closed tab, a sleeping
 * laptop or a page the browser froze, and the configured grace is what covers
 * the difference. An announcement collapses that to one question — is this a
 * reload? — and a reload reconnects to a server on the same machine in well
 * under a second.
 */
export const RELOAD_GRACE_MS = 3_000;

/** An announcement only speaks for the socket that closed right after it. */
const ANNOUNCEMENT_WINDOW_MS = 5_000;

/**
 * The wait before stopping sessions, or `undefined` when the setting disables
 * stopping altogether.
 *
 * Never LONGER than the configured value: somebody who asked for one second
 * asked for one second, and an announcement is a reason to act sooner rather
 * than a licence to act later.
 */
export function stopDelayMs(
  configuredSec: number,
  announcedAt: number | undefined,
  now: number,
): number | undefined {
  if (!Number.isFinite(configuredSec) || configuredSec <= 0) return undefined;
  const configured = configuredSec * 1000;
  const announced = announcedAt !== undefined && now - announcedAt < ANNOUNCEMENT_WINDOW_MS;
  return announced ? Math.min(configured, RELOAD_GRACE_MS) : configured;
}

