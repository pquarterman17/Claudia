import type { SessionSummary } from '@claudia/shared';
import { busySessionIds, sessionsToStop, stopDelayMs } from './client-liveness.js';
import type { FleetStore } from './store/index.js';

/**
 * Closes sessions once the last browser goes away.
 *
 * Lifted out of `gateway.ts`, which is a router: this is a domain rule about
 * what unattended work costs, and it had grown a timer, two pieces of state
 * and a policy decision inside a file whose job is deciding which handler a
 * command belongs to.
 *
 * The rule it enforces is the one this app exists for. A session with no
 * window on it is invisible work that still spends tokens, so it does not get
 * to keep running — but a page reload drops the socket for about a second, and
 * reacting instantly would kill sessions on every refresh. Hence a grace
 * period, and hence `stopDelayMs` deciding how long it needs to be.
 */
export interface ReaperDeps {
  /** Live browsers right now — the gateway owns the sockets and the heartbeats. */
  liveClients: () => number;
  /** Seconds the human asked for, read fresh: it is settable while running. */
  graceSec: () => number;
  orchestrated: () => ReadonlySet<string>;
  fleet: () => FleetStore | undefined;
  summaries: () => SessionSummary[];
  /**
   * Removed rather than stopped. The tab is gone, and a stopped session left
   * behind is a dead tile the human has to clear by hand next time they open
   * the board. Removing stops it first, so the child process dies either way,
   * and the conversation stays in that directory's resume picker.
   */
  remove: (sessionId: string) => void;
}

export class SessionReaper {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private announcedCloseAt: number | undefined;

  constructor(private readonly deps: ReaperDeps) {}

  /**
   * A page said it is unloading.
   *
   * Recorded, not acted on: the socket is still open when this arrives, and
   * the page may be reloading rather than closing. `stopDelayMs` reads it when
   * the socket actually goes.
   */
  announceClosing(now = Date.now()): void {
    this.announcedCloseAt = now;
  }

  /** Called whenever a socket opens, closes, beats, or the sweep runs. */
  check(now = Date.now()): void {
    if (this.deps.liveClients() > 0) {
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
        console.log('[claudia] browser reconnected — sessions kept');
      }
      // That announcement was a reload. Left set, it would shorten the grace
      // for an unrelated drop later on.
      this.announcedCloseAt = undefined;
      return;
    }

    const delay = stopDelayMs(this.deps.graceSec(), this.announcedCloseAt, now);
    if (delay === undefined) return; // disabled: leave sessions running
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.reap(delay);
    }, delay);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private reap(delay: number): void {
    const busy = busySessionIds(this.deps.orchestrated(), this.deps.fleet());
    const closing = sessionsToStop(this.deps.summaries(), busy);
    if (closing.length === 0) {
      if (busy.size > 0) console.log(`[claudia] no browser, but ${busy.size} session(s) are mid-run — kept`);
      return;
    }
    console.log(`[claudia] no browser for ${delay / 1000}s — closing ${closing.length} session(s)`);
    for (const id of closing) this.deps.remove(id);
  }
}
