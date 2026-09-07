import { note } from './pulse-report.js';
import type { FleetStore } from '../store/index.js';

/**
 * The clock's answer to a question nobody answered.
 *
 * `Escalation.expiresAt` documents itself as "when an unanswered request stops
 * being offered", the schema's own comment says that without a time to compare
 * against `expired` is unreachable, and `ESCALATION_RESOLUTIONS` has carried
 * the value since the table was written — but no code path ever set it. So a
 * request with a deadline behaved exactly like one without: pending for good.
 *
 * That was survivable while the inbox was the only reader. It stopped being so
 * when the mission overview began ranking a pending escalation above every
 * other piece of advice it gives, because one unanswered request from months
 * ago then suppresses the budget, ceiling and review guidance for good.
 *
 * Only the clock writes `expired`. `resolve_escalation` deliberately does not
 * offer it — the wire type is `HumanResolution`, which excludes it — because
 * "nobody got to this in time" is a fact about the deadline rather than a
 * decision somebody made.
 */
export function expireEscalations(store: FleetStore, missionId: string, now: number = Date.now()): number {
  const pending = store.escalations.listByMission(missionId, 'pending');
  if (!pending.ok) return 0;

  let expired = 0;
  for (const escalation of pending.value) {
    // `undefined` means the request stands until someone answers it, and a
    // deadline that is not a finite number is not a deadline: `NaN <= now` is
    // false, which is the answer that leaves the request standing. Expiring on
    // an unreadable value would retire the one thing a human is supposed to
    // answer on the strength of a number nobody can read.
    if (escalation.expiresAt === undefined || !Number.isFinite(escalation.expiresAt)) continue;
    if (escalation.expiresAt > now) continue;
    // One at a time, and a refusal is one row's problem: something answering an
    // escalation between the list and the write is a race the human won, not a
    // reason to abandon the rest of the mission's inbox.
    if (!store.escalations.resolve(escalation.id, 'expired', 'nobody answered before it expired').ok) continue;
    expired += 1;
    // In the timeline as well as the inbox, for the reason the filing is:
    // a request that vanishes from the board without a line explaining why
    // reads as one that was answered. Keyed on the escalation, so the note
    // cannot be written twice for the same one.
    note(store, missionId, escalation.taskId, 'escalation_expired', `nobody answered "${escalation.request}" before it expired`, escalation.runId, escalation.id);
  }
  return expired;
}
