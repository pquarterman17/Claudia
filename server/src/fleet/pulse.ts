import type { Mission, Task } from '@claudia/shared';
import { transact } from '../store/db.js';
import type { FleetStore } from '../store/index.js';
import { escalationKey } from './capabilities.js';
import { reconcile, type Decision, type FleetPolicy } from './reconcile.js';
import { assess, nextAction, type RunObservation, type WatchdogAction } from './watchdog.js';

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
    for (const observation of observations) {
      const action = nextAction(assess(observation), observation);
      applyWatchdog(action, mission, observation, deps, result, orders);
    }
    return result;
  });
  if (!applied.ok) return undefined;

  // After the commit, so a process that starts is one the file already
  // describes. A launch that fails now leaves a task the next pulse will see
  // again, rather than a child nothing recorded.
  for (const order of orders) {
    const started = await deps.launch?.(order);
    if (started) result.launched += 1;
    else {
      result.deferred += 1;
      note(store, mission.id, order.taskId, 'launch_failed', `attempt ${order.attempt} did not start`);
    }
  }
  return result;
}

function applyDecision(
  decision: Decision,
  mission: Mission,
  tasks: readonly Task[],
  deps: PulseDeps,
  result: PulseResult,
  orders: LaunchOrder[],
): void {
  const { store } = deps;
  switch (decision.kind) {
    case 'block':
    case 'unblock': {
      // A pure task-state change: nothing is spent, so it is safe to apply
      // without a launcher. `blocked` and `ready` are the two states the
      // reconciler itself reads on the next pulse, which is what makes an
      // unapplied block repeat forever.
      const to = decision.kind === 'block' ? 'blocked' : 'ready';
      const current = tasks.find((task) => task.id === decision.taskId);
      if (current?.status === to) return;
      const moved = store.tasks.setStatus(decision.taskId, to);
      if (!moved.ok) throw new Error(moved.message);
      note(store, mission.id, decision.taskId, `task_${decision.kind}ed`, decision.reason);
      return;
    }
    case 'dispatch': {
      if (deps.launch) {
        // Queued for after the commit. Starting it here would put an external,
        // non-transactional act inside a transaction a later write can roll
        // back, leaving a live child with no durable record of itself.
        orders.push({ missionId: mission.id, taskId: decision.taskId, attempt: decision.attempt, key: decision.key });
        return;
      }
      // Recorded, not swallowed. A fleet that decided to dispatch and could
      // not is a different thing from a fleet with nothing to do, and the
      // difference is only visible if it is written down.
      result.deferred += 1;
      note(store, mission.id, decision.taskId, 'dispatch_deferred', `${decision.reason} (no launcher is wired yet)`);
      return;
    }
    case 'hold':
      // Explanation only. Writing a row per tick for "nothing to do" would
      // bury the log in the one state that carries no information.
      return;
  }
}

function applyWatchdog(
  action: WatchdogAction,
  mission: Mission,
  observation: RunObservation,
  deps: PulseDeps,
  result: PulseResult,
  orders: LaunchOrder[],
): void {
  const { store } = deps;
  const run = observation.run;
  switch (action.kind) {
    case 'wait':
    case 'backoff':
      // `backoff` is a fault whose retry is not due yet. Nothing to write: the
      // next pulse recomputes it from the same fixed anchor, so a row now would
      // be one per tick for a decision that has not changed.
      return;
    case 'escalate': {
      const filed = store.escalations.create({
        missionId: mission.id,
        taskId: run.taskId,
        runId: run.id,
        // `system`, not `child`: this is the watchdog's own finding about a
        // run, not something the run asked for. A `child` source is untrusted
        // input by definition, and mislabelling it here would let a stuck run
        // look like it had requested its own escalation.
        source: 'system',
        request: action.request,
        reason: action.reason,
        severity: action.severity,
        idempotencyKey: action.key,
      });
      // Thrown, not swallowed. Found in review, and my comment here was simply
      // wrong about the repository: `create` already answers an idempotency hit
      // by returning the EXISTING row as `ok`, so a failure is a real store
      // error. Letting it pass committed the rest of the pulse and advanced the
      // cadence while the blocking escalation — the thing a human is supposed
      // to answer — had been dropped.
      if (!filed.ok) throw new Error(filed.message);
      result.escalated += 1;
      return;
    }
    case 'give_up': {
      const ended = store.runs.setState(run.id, action.terminal, { terminalReason: action.reason });
      if (!ended.ok) throw new Error(ended.message);
      for (const status of action.task.path) {
        const moved = store.tasks.setStatus(run.taskId, status);
        if (!moved.ok) throw new Error(moved.message);
      }
      note(store, mission.id, run.taskId, 'task_given_up', action.reason);
      return;
    }
    case 'retry': {
      // The old run is finished either way: it is not coming back, and leaving
      // it `running` holds a concurrency slot for the life of the mission.
      const ended = store.runs.setState(run.id, action.terminal, { terminalReason: action.reason });
      if (!ended.ok) throw new Error(ended.message);
      // The task leaves `running` either way, or nothing will ever look at it
      // again — the wedge recovery.ts exists to close. `path` is the legal
      // route, so every hop is applied in order.
      for (const status of action.task.path) {
        const moved = store.tasks.setStatus(run.taskId, status);
        if (!moved.ok) throw new Error(moved.message);
      }
      if (deps.launch) {
        orders.push({ missionId: mission.id, taskId: run.taskId, attempt: action.attempt, key: action.key });
        return;
      }
      result.deferred += 1;
      note(store, mission.id, run.taskId, 'retry_deferred', `${action.reason} (no launcher is wired yet)`);
      return;
    }
  }
}

/** One line in the mission's timeline, keyed so a repeated tick cannot duplicate it. */
function note(store: FleetStore, missionId: string, taskId: string, kind: string, reason: string): void {
  const appended = store.events.append({
    missionId,
    taskId,
    actor: 'system',
    kind,
    payload: { reason },
    idempotencyKey: escalationKey(`${missionId}:${taskId}`, `${kind}:${reason}`),
  });
  // A duplicate key means this exact note is already in the log, which is the
  // idempotency doing its job rather than a failure worth aborting the pulse.
  if (!appended.ok && !/idempot|unique/i.test(appended.message)) throw new Error(appended.message);
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

  constructor(private readonly deps: PulseDeps) {}

  /** Pulses every watched mission whose own interval has elapsed. */
  async tick(): Promise<PulseResult[]> {
    const missions = this.deps.store.missions.list('active');
    if (!missions.ok) return [];
    const now = this.deps.now?.() ?? Date.now();
    const results: PulseResult[] = [];
    for (const mission of missions.value) {
      if (mission.watch !== 'watching') continue;
      const last = this.lastPulsedAt.get(mission.id);
      if (last !== undefined && now - last < mission.pulseSec * 1000) continue;
      // Stamped only after a pulse that actually landed. Found in review:
      // stamping first meant one transient read or transaction failure
      // suppressed every retry for the mission's whole interval — up to four
      // hours of a fleet deciding nothing because one write lost a race.
      const result = await pulseMission(mission, this.deps);
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
