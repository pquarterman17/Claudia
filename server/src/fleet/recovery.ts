import { isLegalRoute, TASK_TRANSITIONS, type ChildRun, type Task, type TaskStatus } from '@claudia/shared';

/**
 * Putting the fleet back together after the server was not running.
 *
 * Everything live about a session dies with the process: the SDK query, the
 * approval gate, the transcript in memory. What survives is a row saying a run
 * was `running`, which after a restart is a claim about a process that no
 * longer exists. Believing it means a task that occupies a concurrency slot
 * forever and never finishes; ignoring it means re-dispatching work that may
 * have completed. Neither is acceptable, so recovery is an explicit decision
 * per run rather than a default.
 *
 * Pure, because the interesting cases are combinations of persisted state and
 * live state that are miserable to stage against a real server — a run whose
 * session survived, one whose session did not, a task marked running with no
 * run at all — and those are exactly the ones a restart hits.
 */

export type RunRecovery =
  | { kind: 'adopt'; runId: string; sessionId: string; reason: string }
  /** `to` is the terminal state the row MUST be written to. Found in review:
   * calling a run orphaned without terminalizing it leaves the store saying
   * `running`, and the reconciler counts that as an occupied slot forever —
   * so the task is reset to ready and then never dispatched, which is a wedge
   * that looks exactly like a busy fleet. */
  | { kind: 'orphan'; runId: string; to: 'failed'; reason: string }
  | { kind: 'leave'; runId: string };

/**
 * What to do with each persisted run, given the sessions that actually exist.
 *
 * `adopt` is possible at all because Claudia's sessions can outlive a browser
 * and, when the server is restarted by a supervisor that kept them, the ids
 * still resolve. When they do not, the run is orphaned — which is a fact to
 * record, not an error: the work may well have happened, and the evidence is
 * in the worktree either way.
 */
export function recoverRuns(
  runs: readonly ChildRun[],
  liveSessionIds: ReadonlySet<string>,
): RunRecovery[] {
  return runs.map((run) => {
    if (run.state !== 'dispatched' && run.state !== 'running') {
      return { kind: 'leave', runId: run.id };
    }
    if (run.sessionId && liveSessionIds.has(run.sessionId)) {
      return { kind: 'adopt', runId: run.id, sessionId: run.sessionId, reason: 'its session is still running' };
    }
    return {
      kind: 'orphan',
      runId: run.id,
      to: 'failed',
      reason: run.sessionId ? 'its session did not survive the restart' : 'it never recorded a session',
    };
  });
}

/**
 * Where a task must end up, and the legal route to get it there.
 *
 * `path` rather than a single destination because the state machine does not
 * always allow the obvious hop: a task caught `running` by a crash belongs
 * back in the queue, but `running -> ready` is not a transition — the route is
 * `running -> failed -> ready`, and it is more truthful anyway, since that
 * attempt did fail. Applying `path` in order is the whole contract; a caller
 * that writes only the last element gets its write refused.
 */
export type TaskRecovery = { taskId: string; to: TaskStatus; path: readonly TaskStatus[]; reason: string };

/**
 * The route back into the queue, named rather than searched for.
 *
 * Via `failed`, because that attempt did fail — the server died under it. The
 * other two-hop route the state machine allows is via `reported`, which would
 * assert that a child claimed the work was finished. Both are legal; only one
 * is true, and nothing but this module knows which.
 */
const TO_QUEUE: readonly TaskStatus[] = ['failed', 'ready'];
/** Already a standing claim; it only has to be recorded as one. */
const TO_REVIEW: readonly TaskStatus[] = ['reported'];

/** Builds the recovery, refusing to emit a move the store would reject. */
function move(task: Task, route: readonly TaskStatus[], reason: string): TaskRecovery | undefined {
  if (!isLegalRoute(task.status, route, TASK_TRANSITIONS)) return undefined;
  const to = route[route.length - 1];
  return to ? { taskId: task.id, to, path: route, reason } : undefined;
}

/**
 * Tasks whose status no longer matches reality.
 *
 * A task left `running` with nothing running is the characteristic post-crash
 * state, and it is the one that quietly wedges a mission: the reconciler skips
 * it (not ready) and the watchdog never sees it (no live run). Sending it back
 * to `ready` is safe because a retry is a new run — the old attempt is still
 * counted, so this cannot become an unbounded loop.
 *
 * `reported` is deliberately left alone. It is a claim awaiting a decision,
 * and a restart is not a reason to withdraw it.
 */
export function recoverTasks(
  tasks: readonly Task[],
  runs: readonly ChildRun[],
  adoptedRunIds: ReadonlySet<string>,
): TaskRecovery[] {
  // The LATEST attempt decides, not whichever attempt happens to look best. A
  // task whose attempt 1 was reported and rejected, and whose attempt 2 was
  // running at the crash, must not come back as a claim from the stale one.
  const latest = new Map<string, ChildRun>();
  for (const run of runs) {
    const held = latest.get(run.taskId);
    if (!held || run.attempt > held.attempt) latest.set(run.taskId, run);
  }

  // ANY surviving run, not just the latest one. A task whose latest attempt
  // failed while an earlier one is still alive must not be requeued: that
  // dispatches a second agent alongside one already working, in the same
  // worktree. The latest attempt decides WHERE a task goes; any live run
  // decides whether it moves at all.
  const alive = new Set(runs.filter((run) => adoptedRunIds.has(run.id)).map((run) => run.taskId));

  const recoveries: TaskRecovery[] = [];
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    if (alive.has(task.id)) continue;
    const run = latest.get(task.id);

    const recovery =
      run?.state === 'reported'
        ? // That attempt finished and its evidence is in the worktree. Sending
          // it back to the queue throws the work away and pays for it twice.
          move(task, TO_REVIEW, 'its latest run reported before the server stopped; the work is waiting on review')
        : move(task, TO_QUEUE, 'it was running when the server stopped, and nothing is running now');
    if (recovery) recoveries.push(recovery);
  }
  return recoveries;
}

/**
 * The whole recovery, as one set of transitions to apply together.
 *
 * Returned as a unit because the two halves are only correct together: writing
 * the task back to `ready` while its run row still says `running` is the wedge
 * described above. A caller applying this in a transaction cannot land one
 * without the other.
 */
export function planRecovery(
  tasks: readonly Task[],
  runs: readonly ChildRun[],
  liveSessionIds: ReadonlySet<string>,
): { runs: RunRecovery[]; tasks: TaskRecovery[] } {
  const runRecoveries = recoverRuns(runs, liveSessionIds);
  const adopted = new Set(runRecoveries.filter((r) => r.kind === 'adopt').map((r) => r.runId));
  return { runs: runRecoveries, tasks: recoverTasks(tasks, runs, adopted) };
}

/**
 * A one-line account of what recovery did, for the event log.
 *
 * Worth writing even when it is all zeroes: "recovered 0 runs" after a restart
 * is the difference between a fleet that came back clean and one that never
 * ran recovery at all, and only the log can tell those apart later.
 */
export function describeRecovery(runs: readonly RunRecovery[], tasks: readonly TaskRecovery[]): string {
  const adopted = runs.filter((r) => r.kind === 'adopt').length;
  const orphaned = runs.filter((r) => r.kind === 'orphan').length;
  // Counted per destination. Found in review: saying "reset to ready" for
  // tasks actually restored to `reported` describes the opposite of what
  // happened, in the one line a human reads to find out what a restart did.
  const byDestination = new Map<string, number>();
  for (const task of tasks) byDestination.set(task.to, (byDestination.get(task.to) ?? 0) + 1);
  const moved = [...byDestination.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([to, count]) => `${count} to ${to}`)
    .join(', ');
  return `recovered ${adopted} run(s), orphaned ${orphaned}, moved ${tasks.length} task(s)${moved ? `: ${moved}` : ''}`;
}
