import { recovered, skipFleet } from './pulse-report.js';
import { pulseMission, readPolicy, type PulseConfig, type PulseResult } from './pulse.js';

/**
 * The clock: which missions are due, and nothing else.
 *
 * Split out of `pulse.ts` when the retire pass pushed that file over the size
 * ceiling, along the seam its own comment already described: everything else
 * there decides what to do about ONE mission, and this is the only part that
 * remembers anything between ticks.
 *
 * Each mission carries its own `pulseSec`, so one global interval cannot be the
 * cadence: a mission set to four hours must not be decided on every fifteen
 * seconds because another one is. The ticker fires often; this decides which
 * missions are actually due.
 *
 * Due times are in memory and not persisted, which means a restart pulses
 * everything once. That is the behaviour worth having — a fleet that has just
 * recovered its rows should look at them — and persisting it would buy a
 * suppressed first pulse in exchange for a column to keep in step.
 */
export class FleetPulser {
  private readonly lastPulsedAt = new Map<string, number>();
  /** Missions with a pulse still awaiting its launchers. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly config: PulseConfig) {}

  /** Pulses every watched mission whose own interval has elapsed. */
  async tick(): Promise<PulseResult[]> {
    const missions = this.config.store.missions.list('active');
    // The fleet's widest failure, and the quietest: an unreadable mission list
    // is a tick that decides nothing for EVERY mission, and until this line it
    // was indistinguishable from a tick with nothing due.
    if (!missions.ok) return skipFleet(missions.message);
    recovered('fleet');
    const now = this.config.now?.() ?? Date.now();
    const results: PulseResult[] = [];
    for (const mission of missions.value) {
      if (mission.watch !== 'watching') continue;
      // Never two pulses of one mission at once. Found in review, and it is
      // the cost of the previous round's fix: `setInterval` does not wait for
      // the prior tick, and the cadence is now stamped only AFTER every
      // launcher has been awaited — so a startup slower than the tick interval
      // left a second tick reading the same ready task and the same
      // no-run snapshot, and enqueueing the same paid launch again. Released
      // in `finally`, or one thrown pulse would wedge the mission forever.
      if (this.inFlight.has(mission.id)) continue;
      const last = this.lastPulsedAt.get(mission.id);
      if (last !== undefined && now - last < mission.pulseSec * 1000) continue;
      this.inFlight.add(mission.id);
      let result: PulseResult | undefined;
      try {
        // Read per mission, so a limit lowered mid-tick binds the next
        // mission rather than none of them.
        result = await pulseMission(mission, readPolicy(this.config));
      } catch (err) {
        // One mission's failure is not the fleet's. The production caller is a
        // timer that discards this promise, so a rejection escaping here is an
        // unhandled rejection AND a tick that silently abandoned every mission
        // after this one. Left unstamped, so the next tick tries again.
        console.error(`[claudia] pulse failed for mission ${mission.id}:`, err);
      } finally {
        this.inFlight.delete(mission.id);
      }
      // Stamped only after a pulse that actually landed. Found in review:
      // stamping first meant one transient read or transaction failure
      // suppressed every retry for the mission's whole interval — up to four
      // hours of a fleet deciding nothing because one write lost a race.
      if (result) {
        this.lastPulsedAt.set(mission.id, now);
        results.push(result);
      }
    }
    return results;
  }

  /** Drops missions that no longer exist, so the map cannot grow forever. */
  forget(missionIds: ReadonlySet<string>): void {
    for (const id of this.lastPulsedAt.keys()) {
      if (!missionIds.has(id)) this.lastPulsedAt.delete(id);
    }
  }
}
