import type { Mission } from '@claudia/shared';
import type { FleetStore } from '../store/index.js';
import { escalationKey } from './capabilities.js';
import type { PulseResult } from './pulse.js';

/**
 * Saying what a pulse did, and why it did not do more.
 *
 * Two audiences, one subject. `skipFleet` and `skipMission' write to the
 * console, for whoever is running the server; `note` writes to the mission's
 * own timeline, for whoever is reading the board. Both exist because a fleet
 * that quietly stops deciding is indistinguishable from one with nothing to
 * decide, and both suppress a repeat rather than filling their channel — the
 * console by remembering the last reason per scope, the log by an idempotency
 * key over (mission, kind, reason).
 *
 * Its own module because `pulse.ts` and `pulse-apply.ts` both crossed the size
 * ceiling this round, and this is the seam worth cutting on rather than a
 * line-count trade: nothing in the orchestration above needs to know how a
 * repeat is suppressed.
 */

/**
 * The last reason reported for each scope — the fleet, or one mission.
 *
 * A pulse that fails is not stamped, so it is retried on the very next tick:
 * every fifteen seconds, for as long as the fault lasts. Reporting each of
 * those would bury the line that matters under four an hour times sixty, so a
 * reason is said when it STARTS and again only if it changes or comes back.
 *
 * Cleared on success, which is what makes a fault that returns get said twice
 * rather than once. Keyed by scope and not by message, so a mission whose
 * failure changes shape reports the new shape.
 */
const reported = new Map<string, string>();

function report(scope: string, line: string, reason: string): void {
  if (reported.get(scope) === reason) return;
  reported.set(scope, reason);
  console.error(line);
}

/** Forgets a scope's last failure, so its next one is reported. */
export function recovered(scope: string): void {
  reported.delete(scope);
}

/**
 * Reports a tick that could not even find out what to pulse.
 *
 * Answers an empty list, which is what the caller does with it either way —
 * the point is that the reason reaches somebody.
 */
export function skipFleet(reason: string): PulseResult[] {
  report('fleet', `[claudia] fleet pulse skipped: could not read missions: ${reason}`, reason);
  return [];
}

/**
 * Reports why one mission's pulse decided nothing, and answers `undefined`.
 *
 * `undefined` is the caller's signal to leave the mission unstamped and try
 * again next tick, which is right — but on its own it is silent, and a fleet
 * that has silently stopped deciding looks exactly like a fleet with nothing
 * to decide.
 */
export function skipMission(mission: Mission, reason: string): undefined {
  report(mission.id, `[claudia] pulse skipped for mission ${mission.id} (${mission.name}): ${reason}`, reason);
  return undefined;
}

/** One line in the mission's timeline, keyed so a repeated tick cannot duplicate it. */
export function note(
  store: FleetStore,
  missionId: string,
  /** Absent for a note about the mission itself, such as a budget it has spent. */
  taskId: string | undefined,
  kind: string,
  reason: string,
): void {
  const appended = store.events.append({
    missionId,
    ...(taskId !== undefined ? { taskId } : {}),
    actor: 'system',
    kind,
    payload: { reason },
    // Keyed on the mission alone when there is no task, rather than on the
    // string "undefined" — the exact shape of a bug this repository has
    // already had once, in an escalation key that read "escalation:r1:undefined".
    idempotencyKey: escalationKey(taskId === undefined ? missionId : `${missionId}:${taskId}`, `${kind}:${reason}`),
  });
  // A duplicate key means this exact note is already in the log, which is the
  // idempotency doing its job rather than a failure worth aborting the pulse.
  if (!appended.ok && !/idempot|unique/i.test(appended.message)) throw new Error(appended.message);
}
