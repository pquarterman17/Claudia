import type { AgentKind, Mission, SessionState } from '@claudia/shared';
import { transact } from '../store/db.js';
import type { FleetStore } from '../store/index.js';
import { judgeReported } from './evidence.js';
import { retireWorktrees } from './worktree-retire.js';
import { expireEscalations } from './escalation-expiry.js';
import { applyDecision, applyWatchdogOutcomes } from './pulse-apply.js';
import { compensateLaunch } from './pulse-reserve.js';
import { recovered, skipFleet, skipMission } from './pulse-report.js';
import { reconcile, type FleetPolicy, type MissionSpend } from './reconcile.js';
import { recordSpend, spendOf } from './pulse-spend.js';
import { DEFAULT_WATCHDOG, type WatchdogPolicy } from './watchdog-policy.js';
import type { RunObservation } from './watchdog.js';

/**
 * One tick of a mission: what the reconciler decides, what the watchdog finds,
 * and the durable consequences of both.
 *
 * The two engines have been decidable and unrunnable since they landed. This
 * gives them a clock. It deliberately does NOT give them a way to start a
 * session — see `LaunchChild` below.
 *
 * Everything here is applied per mission and inside one transaction per tick,
 * so a pulse either lands whole or not at all. A half-applied pulse is the
 * state the whole fleet is written to avoid: a task moved without its run row,
 * or an escalation filed for an action that was then rolled back.
 */

/**
 * The seam where a decision becomes a running agent.
 *
 * Not implemented in this PR, and the absence is the point. Dispatching for
 * real means claiming a worktree, creating the run row under the reservation
 * key, and launching through the session manager — each with its own failure
 * modes, and together a change larger than the pulse itself. A port keeps that
 * honest: the pulse computes and records, and what it cannot do it says so
 * about, rather than pretending the decision was carried out.
 */
export interface LaunchOrder {
  missionId: string;
  taskId: string;
  /**
   * The run row already written for this attempt, before anything was
   * launched. Found in review: without it a launcher that succeeded left the
   * task `ready` and no run at all, so the next pulse computed the same
   * attempt and paid for it again. The row is the reservation — the store
   * refuses a second at the same (task, attempt) — and it is what the launcher
   * attaches its session to, and what releases the claim if it never starts.
   */
  runId: string;
  /**
   * The harness to start, taken from the run row rather than re-read off the
   * mission. The reservation is what a retry, a restart and the watchdog all
   * agree happened; a mission edited between the write and the launch must not
   * change what a started child actually is.
   */
  agent: AgentKind;
  attempt: number;
  key: string;
}

/**
 * Asynchronous, and called AFTER the transaction commits — both from review.
 *
 * Starting a child is an external, non-transactional act: a worktree appears on
 * disk and a process starts. Doing that inside the transaction meant a later
 * write could roll back the run row and the reservation while the process it
 * described was still alive — an orphan with no durable record, which is worse
 * than the dispatch never happening. A boolean return could not express the
 * real launch path either, which is async.
 */
export type LaunchChild = (order: LaunchOrder) => Promise<boolean>;

/**
 * What the watchdog needs to know about a session, as opposed to whether its
 * id appears in a list.
 *
 * Found in review, and it is the difference between a watchdog that works and
 * one that fires on healthy runs: without `lastActivityAt`, `assess` falls back
 * to `run.startedAt`, so ANY live run older than `silentAfterMs` reads as
 * silent and is failed or retried while it is still producing output. Without
 * the approval fields, a run parked on a human is retried — spending a fresh
 * turn that parks on the same approval — instead of escalated.
 */
export interface SessionFacts {
  lastActivityAt: number;
  /**
   * What the session says it is doing.
   *
   * Optional because it was added after the fact and absent means "nobody
   * said", which reads as not-idle — the behaviour every caller had before it
   * existed. `idle` is the one value that matters here: the SDK reports it
   * when a TURN ENDED, not between tool calls, so for a child given one brief
   * it is the child saying it is finished.
   */
  state?: SessionState;
  /**
   * Tokens this session has spent, input and output together.
   *
   * Optional, and absent means the observer could not say — which the run row
   * keeps as an unknown rather than turning into a zero. Cumulative and
   * updated at turn end, like the summary it comes from.
   */
  tokens?: number;
  /** Tool name it is parked on, when it is parked. */
  pendingApproval?: string;
  /** When it parked. */
  pendingSince?: number;
}

/** Only sessions that are actually alive; a stopped tile is not one. */
export type ObserveSessions = () => ReadonlyMap<string, SessionFacts>;

export interface PulseDeps {
  store: FleetStore;
  /** The limits ONE pulse decides and spends against, already read. */
  policy: FleetPolicy;
  /** Absent means nothing launches; every dispatch is recorded as deferred. */
  launch?: LaunchChild;
  /** Read at every tick rather than captured once: a snapshot frozen at
   * construction would age into a claim that dead sessions are alive, which is
   * the one fault the watchdog exists to catch. */
  observeSessions: ObserveSessions;
  now?: () => number;
}

/**
 * A fixed policy, or a way to read the one currently configured.
 *
 * The fleet's ceilings are a user preference now, so the number in force can
 * change between one pulse and the next. A supplier is how the long-lived
 * ticker sees that change without being rebuilt — the same reason
 * `observeSessions` is a function rather than a snapshot.
 *
 * Read ONCE per mission, never per use. Two reads inside one pulse could
 * straddle a settings write and let the half that decides to dispatch disagree
 * with the half that checks for a free slot, which is exactly the split the
 * shared `maxAttempts` fix closed on the watchdog.
 */
export type FleetPolicySource = FleetPolicy | (() => FleetPolicy);

/** What a long-lived caller holds: a pulse whose policy is not yet read. */
export interface PulseConfig extends Omit<PulseDeps, 'policy'> {
  policy: FleetPolicySource;
}

/** Exported for `pulser.ts`, which reads the limits once per mission per tick. */
export function readPolicy(config: PulseConfig): PulseDeps {
  return { ...config, policy: typeof config.policy === 'function' ? config.policy() : config.policy };
}

export interface PulseResult {
  missionId: string;
  decisions: number;
  launched: number;
  deferred: number;
  escalated: number;
  /** Runs whose child finished its turn and whose task now awaits a decision. */
  reported: number;
  /**
   * Worktrees this pulse stopped calling `active`.
   *
   * Reported alongside the launches because it is the same kind of fact: what
   * the pulse did to the fleet's own records. Without it the pass is a column
   * change nobody outside the store could observe.
   */
  retired: number;
  /** Requests whose deadline passed with nobody answering them. */
  expired: number;
  /**
   * What this pulse measured the mission to have spent.
   *
   * Carried out rather than recomputed by the caller, so the number a board is
   * shown is the number the budget decision was made on. Recomputing it a
   * moment later would be a second measurement of a moving quantity, and the
   * two would differ on exactly the ticks where a child was spending.
   */
  spend: MissionSpend;
}

/**
 * Pulses every mission that is being watched.
 *
 * Only `watching` missions, and only `active` ones. A paused mission is a
 * deliberate instruction to stop deciding on its behalf, and a completed or
 * archived one has nothing to decide. Recovery, by contrast, runs over all of
 * them — reconciling stale rows is repair, not a decision to spend.
 */
export async function pulseFleet(config: PulseConfig): Promise<PulseResult[]> {
  const missions = config.store.missions.list('active');
  if (!missions.ok) return skipFleet(missions.message);
  const results: PulseResult[] = [];
  for (const mission of missions.value) {
    if (mission.watch !== 'watching') continue;
    const result = await pulseMission(mission, readPolicy(config));
    if (result) results.push(result);
  }
  return results;
}

export async function pulseMission(mission: Mission, deps: PulseDeps): Promise<PulseResult | undefined> {
  const { store } = deps;
  const tasks = store.tasks.listByMission(mission.id);
  const runs = store.runs.listByMission(mission.id);
  // Said out loud, not swallowed. A pulse that cannot read its own rows
  // decides nothing, and the ticker's only other trace of that is a mission
  // that quietly stops moving — the exact symptom that is impossible to
  // diagnose from the outside.
  if (!tasks.ok) return skipMission(mission, `could not read tasks: ${tasks.message}`);
  if (!runs.ok) return skipMission(mission, `could not read runs: ${runs.message}`);

  const now = deps.now?.() ?? Date.now();
  const live = deps.observeSessions();
  // Written down BEFORE anything is decided, so this pulse's budget check sees
  // what the mission has actually spent — and so the count survives the
  // session that knows it. A child observed once and then gone leaves its last
  // reading on the row; a child never observed leaves an unknown, which is the
  // honest answer and the one `overBudget` holds on.
  const measured = recordSpend(store, runs.value, live);
  // The mission's own ceiling and the fleet's, whichever binds first. The
  // reconciler already takes the lower of the two; passing the fleet policy
  // alone would let a mission set to one child dispatch the fleet default.
  const spend = spendOf(measured, now);
  const decisions = reconcile({
    mission,
    tasks: tasks.value,
    runs: measured,
    policy: deps.policy,
    spend,
  });
  // ONE bound on attempts, shared by the half that decides and the half that
  // spends. Found in review: `reconcile` was handed `deps.policy.maxAttempts`
  // while the watchdog silently fell back to `DEFAULT_WATCHDOG`'s 3 — so a
  // fleet limited to one attempt still got a second one from the watchdog, and
  // a fleet allowed more than three gave up early. The component authorised to
  // spend must not carry a looser bound than the one that decides. An
  // unreadable bound is not defaulted here either: `nextAction` escalates on a
  // policy it cannot use, which is the right answer to a missing limit.
  const watchdogPolicy: WatchdogPolicy = { ...DEFAULT_WATCHDOG, maxAttempts: deps.policy.maxAttempts };

  const observations = measured
    .filter((run) => run.state === 'dispatched' || run.state === 'running')
    .map<RunObservation>((run) => {
      // The session's OWN account of itself, not merely that its id was in a
      // list. `facts` absent means no live session answers to this id, which is
      // what `orphaned` means.
      const facts = run.sessionId === undefined ? undefined : live.get(run.sessionId);
      return {
        run,
        sessionAlive: facts !== undefined,
        ...(facts?.state !== undefined ? { state: facts.state } : {}),
        attemptsSpent: Math.max(...measured.filter((r) => r.taskId === run.taskId).map((r) => r.attempt)),
        ...(facts?.lastActivityAt !== undefined ? { lastActivityAt: facts.lastActivityAt } : {}),
        ...(facts?.pendingApproval !== undefined ? { pendingApproval: facts.pendingApproval } : {}),
        ...(facts?.pendingSince !== undefined ? { pendingSince: facts.pendingSince } : {}),
        now,
      };
    });

  const result: PulseResult = {
    missionId: mission.id,
    decisions: decisions.length,
    launched: 0,
    deferred: 0,
    escalated: 0,
    expired: 0,
    reported: 0,
    retired: 0,
    spend,
  };
  // Collected, not executed. Everything inside the transaction is a durable
  // write that can roll back; a launched process cannot.
  const orders: LaunchOrder[] = [];
  const applied = transact(store.db, 'apply a fleet pulse', () => {
    for (const decision of decisions) applyDecision(decision, mission, tasks.value, deps, result, orders);
    applyWatchdogOutcomes(mission, observations, watchdogPolicy, deps, result, orders);
    return result;
  });
  // Nothing was written and nothing was launched: the orders were collected
  // inside the transaction that rolled back, so there is no compensation to
  // do here, only a reason to report.
  if (!applied.ok) return skipMission(mission, `could not apply the pulse: ${applied.message}`);

  // After the commit, so a process that starts is one the file already
  // describes. A launch that fails now leaves a task the next pulse will see
  // again, rather than a child nothing recorded.
  let reason = 'the launcher declined';
  for (const order of orders) {
    // Each order caught on its own. Found in review, and a defect the async
    // port introduced: a real worktree or process startup can REJECT, and an
    // uncaught rejection escaped `pulseMission`, skipped every remaining
    // order, wrote no `launch_failed`, and surfaced as an unhandled rejection
    // because the production timer discards this promise by design. A launcher
    // that throws is a launch that did not happen, which is the case already
    // handled one line down.
    let started = false;
    try {
      started = (await deps.launch?.(order)) === true;
    } catch (err) {
      started = false;
      reason = err instanceof Error ? err.message : String(err);
    }
    if (started) {
      result.launched += 1;
      continue;
    }
    result.deferred += 1;
    // The reservation is durable, so something has to release it. Leaving the
    // run `dispatched` for a child that never started would hold a concurrency
    // slot for the life of the mission and keep the task out of the queue.
    compensateLaunch(deps, mission.id, order, reason);
    reason = 'the launcher declined';
  }

  // After the commit for the same reason the launches are: reading a worktree
  // is git, and git is I/O that has no business inside a transaction. Its own
  // failures are its own — a claim that could not be checked is still a claim,
  // and losing the whole pulse over it would be worse than an unjudged report.
  try {
    await judgeReported(deps, mission);
  } catch (err) {
    console.error(`[claudia] could not judge reported runs for mission ${mission.id}:`, err);
  }
  // After judging, not before: judging reads the worktree, so a report read on
  // this same pulse leaves a directory the retire pass may then let go of.
  // Nothing here touches the filesystem — it writes `idle` over a record that
  // has been claiming `active` since the run that held it ended.
  result.retired = retireWorktrees(store, mission.id);
  // The clock's pass, and the only writer of `expired`. Cheap — one indexed
  // read of the pending inbox — and it runs regardless of what else this pulse
  // decided, because a deadline passing is not conditional on the fleet having
  // had work to do.
  result.expired = expireEscalations(store, mission.id);
  recovered(mission.id);
  return result;
}
