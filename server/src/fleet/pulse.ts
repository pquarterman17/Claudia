import type { Mission, Task } from '@claudia/shared';
import { transact } from '../store/db.js';
import type { FleetStore } from '../store/index.js';
import { applyDecision, applyWatchdogOutcomes, compensateLaunch } from './pulse-apply.js';
import { reconcile, type FleetPolicy } from './reconcile.js';
import { DEFAULT_WATCHDOG, type RunObservation, type WatchdogPolicy } from './watchdog.js';

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
  /** Tool name it is parked on, when it is parked. */
  pendingApproval?: string;
  /** When it parked. */
  pendingSince?: number;
}

/** Only sessions that are actually alive; a stopped tile is not one. */
export type ObserveSessions = () => ReadonlyMap<string, SessionFacts>;

export interface PulseDeps {
  store: FleetStore;
  policy: FleetPolicy;
  /** Absent means nothing launches; every dispatch is recorded as deferred. */
  launch?: LaunchChild;
  /** Read at every tick rather than captured once: a snapshot frozen at
   * construction would age into a claim that dead sessions are alive, which is
   * the one fault the watchdog exists to catch. */
  observeSessions: ObserveSessions;
  now?: () => number;
}

export interface PulseResult {
  missionId: string;
  decisions: number;
  launched: number;
  deferred: number;
  escalated: number;
}

/**
 * Pulses every mission that is being watched.
 *
 * Only `watching` missions, and only `active` ones. A paused mission is a
 * deliberate instruction to stop deciding on its behalf, and a completed or
 * archived one has nothing to decide. Recovery, by contrast, runs over all of
 * them — reconciling stale rows is repair, not a decision to spend.
 */
export async function pulseFleet(deps: PulseDeps): Promise<PulseResult[]> {
  const missions = deps.store.missions.list('active');
  if (!missions.ok) return [];
  const results: PulseResult[] = [];
  for (const mission of missions.value) {
    if (mission.watch !== 'watching') continue;
    const result = await pulseMission(mission, deps);
    if (result) results.push(result);
  }
  return results;
}

export async function pulseMission(mission: Mission, deps: PulseDeps): Promise<PulseResult | undefined> {
  const { store } = deps;
  const tasks = store.tasks.listByMission(mission.id);
  const runs = store.runs.listByMission(mission.id);
  if (!tasks.ok || !runs.ok) return undefined;

  const now = deps.now?.() ?? Date.now();
  const live = deps.observeSessions();
  // The mission's own ceiling and the fleet's, whichever binds first. The
  // reconciler already takes the lower of the two; passing the fleet policy
  // alone would let a mission set to one child dispatch the fleet default.
  const decisions = reconcile({ mission, tasks: tasks.value, runs: runs.value, policy: deps.policy });
  // ONE bound on attempts, shared by the half that decides and the half that
  // spends. Found in review: `reconcile` was handed `deps.policy.maxAttempts`
  // while the watchdog silently fell back to `DEFAULT_WATCHDOG`'s 3 — so a
  // fleet limited to one attempt still got a second one from the watchdog, and
  // a fleet allowed more than three gave up early. The component authorised to
  // spend must not carry a looser bound than the one that decides. An
  // unreadable bound is not defaulted here either: `nextAction` escalates on a
  // policy it cannot use, which is the right answer to a missing limit.
  const watchdogPolicy: WatchdogPolicy = { ...DEFAULT_WATCHDOG, maxAttempts: deps.policy.maxAttempts };

  const observations = runs.value
    .filter((run) => run.state === 'dispatched' || run.state === 'running')
    .map<RunObservation>((run) => {
      // The session's OWN account of itself, not merely that its id was in a
      // list. `facts` absent means no live session answers to this id, which is
      // what `orphaned` means.
      const facts = run.sessionId === undefined ? undefined : live.get(run.sessionId);
      return {
        run,
        sessionAlive: facts !== undefined,
        attemptsSpent: Math.max(...runs.value.filter((r) => r.taskId === run.taskId).map((r) => r.attempt)),
        ...(facts?.lastActivityAt !== undefined ? { lastActivityAt: facts.lastActivityAt } : {}),
        ...(facts?.pendingApproval !== undefined ? { pendingApproval: facts.pendingApproval } : {}),
        ...(facts?.pendingSince !== undefined ? { pendingSince: facts.pendingSince } : {}),
        now,
      };
    });

  const result: PulseResult = { missionId: mission.id, decisions: decisions.length, launched: 0, deferred: 0, escalated: 0 };
  // Collected, not executed. Everything inside the transaction is a durable
  // write that can roll back; a launched process cannot.
  const orders: LaunchOrder[] = [];
  const applied = transact(store.db, 'apply a fleet pulse', () => {
    for (const decision of decisions) applyDecision(decision, mission, tasks.value, deps, result, orders);
    applyWatchdogOutcomes(mission, observations, watchdogPolicy, deps, result, orders);
    return result;
  });
  if (!applied.ok) return undefined;

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
  return result;
}

/**
 * The clock, and the only thing in this module that remembers anything.
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

  constructor(private readonly deps: PulseDeps) {}

  /** Pulses every watched mission whose own interval has elapsed. */
  async tick(): Promise<PulseResult[]> {
    const missions = this.deps.store.missions.list('active');
    if (!missions.ok) return [];
    const now = this.deps.now?.() ?? Date.now();
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
        result = await pulseMission(mission, this.deps);
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
