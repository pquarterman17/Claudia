import type { ChildRun, Task } from '@claudia/shared';

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

export type TaskRecovery = { taskId: string; to: Task['status']; reason: string };

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
  const stillRunning = new Set(
    runs.filter((run) => adoptedRunIds.has(run.id)).map((run) => run.taskId),
  );
  // A run that finished and reported before the crash did real work, and its
  // evidence is in the worktree. Found in review: resetting such a task to
  // `ready` throws that away and pays for it again, which is the one recovery
  // outcome worse than doing nothing.
  const reported = new Set(runs.filter((run) => run.state === 'reported').map((run) => run.taskId));
  const recoveries: TaskRecovery[] = [];
  for (const task of tasks) {
    if (task.status !== 'running') continue;
    if (stillRunning.has(task.id)) continue;
    if (reported.has(task.id)) {
      recoveries.push({
        taskId: task.id,
        to: 'reported',
        reason: 'its run reported before the server stopped; the work is waiting on review',
      });
      continue;
    }
    recoveries.push({
      taskId: task.id,
      to: 'ready',
      reason: 'it was running when the server stopped, and nothing is running now',
    });
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
  return `recovered ${adopted} run(s), orphaned ${orphaned}, reset ${tasks.length} task(s) to ready`;
}
