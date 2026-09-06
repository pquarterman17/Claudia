import type { ChildRun } from '@claudia/shared';
import type { FleetStore } from '../store/index.js';
import type { MissionSpendReport } from '@claudia/shared';
import type { MissionSpend } from './reconcile.js';
import type { SessionFacts } from './pulse.js';

/**
 * What a mission has spent, and where the number comes from.
 *
 * Split out of `pulse.ts` when the token half stopped being a placeholder and
 * pushed that file over the size ceiling. The two functions belong together:
 * one writes the measurement down, the other adds it up, and the rule they
 * share — an unknown is not a zero — is the whole reason the fleet can be
 * trusted with a budget at all.
 */

/**
 * What the mission has spent, measured rather than assumed.
 *
 * `overBudget` was written with this and never given it: `reconcile` takes
 * `spend` as optional and `pulseMission` never passed one, so `if (!spend)
 * return undefined` meant a mission with a budget ran forever. A limit that is
 * persisted, settable and enforcing nothing is the worst shape a limit can
 * take — the comment on `overBudget` says so, about the version of this bug it
 * had already fixed one layer up.
 *
 * `elapsedSec` is WALL CLOCK from the moment this mission first started
 * spending, which is what `Mission.budgetSec` says it is. Not the sum of its
 * children's runtimes: that is a different and also useful bound — four
 * children for an hour is four hours of machine — but it is not what the field
 * promises, and quietly changing what a stored limit means is worse than not
 * enforcing it. Nothing has been spent before the first run, so a mission that
 * has never dispatched reads zero rather than its age.
 *
 * `tokens` is summed from the runs themselves, which is why the column exists.
 * It used to be NaN — honestly, since the counts lived on sessions that end —
 * and `overBudget` held every mission with a token budget from its first
 * pulse: settable, visible, and enforcing a stop rather than a bound.
 *
 * ONE unreadable run makes the whole sum unreadable, deliberately. A mission's
 * budget is spent by every attempt it has made, so skipping the runs nobody
 * could measure would report a spend that is definitely too low and call it a
 * measurement. `overBudget` holds on that, which is the fleet's standing bias:
 * an unknown is not permission. A run that never got a session is the one
 * exception, and it is not an unknown — a reservation whose launch failed
 * spent nothing, and its row says zero.
 */
export function spendOf(runs: readonly ChildRun[], now: number): MissionSpend {
  const started = runs.map((run) => run.startedAt).filter((at) => Number.isFinite(at));
  const from = started.length === 0 ? undefined : Math.min(...started);
  let tokens = 0;
  for (const run of runs) {
    if (run.tokens === undefined) tokens = Number.NaN;
    else if (Number.isFinite(tokens)) tokens += run.tokens;
  }
  return {
    elapsedSec: from === undefined ? 0 : Math.max(0, (now - from) / 1000),
    tokens,
  };
}

/**
 * Copies what each live session says it has spent onto its run row.
 *
 * Answers with the runs as they now read, rather than re-reading them: the
 * write and the decision that follows have to agree, and a second read is a
 * second chance for them not to.
 *
 * A failure to write is not a failure to pulse. The count is a measurement,
 * and losing one tick of it costs accuracy the next tick restores — whereas
 * abandoning the pulse would strand every decision behind it.
 */
export function recordSpend(
  store: FleetStore,
  runs: readonly ChildRun[],
  live: ReadonlyMap<string, SessionFacts>,
): ChildRun[] {
  return runs.map((run) => {
    const tokens = run.sessionId === undefined ? undefined : live.get(run.sessionId)?.tokens;
    if (tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0) return run;
    const written = store.runs.recordTokens(run.id, tokens);
    if (!written.ok) {
      console.error(`[claudia] could not record the spend of run ${run.id}:`, written.message);
      return run;
    }
    return written.value;
  });
}

/**
 * A spend as the wire carries it.
 *
 * `null` where the sum is not a number, in ONE place: JSON has no NaN, and two
 * conversions would eventually disagree about which way an unmeasurable spend
 * leans. Zero is the wrong lie — that is the state in which the fleet refuses
 * to dispatch, and a board drawing it as nothing spent would show headroom the
 * mission does not have.
 */
export function reportOf(missionId: string, spend: MissionSpend): MissionSpendReport {
  return {
    missionId,
    elapsedSec: spend.elapsedSec,
    tokens: Number.isFinite(spend.tokens) ? spend.tokens : null,
  };
}
