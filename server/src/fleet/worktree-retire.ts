import type { WorktreeRecord } from '@claudia/shared';
import { hasJudgement } from './evidence.js';
import type { FleetStore } from '../store/index.js';

/**
 * Letting go of a worktree the fleet has finished with.
 *
 * `worktree-owner.ts` has two halves. `claimWorktree` decides who may take a
 * directory, and every launch goes through it. `cleanupWorktree` decides what
 * may be thrown away — and its FIRST substantive check is:
 *
 *     if (record.state === 'active') return { kind: 'keep', ... };
 *
 * Nothing in the fleet had ever written any other state. `claimWorktree`
 * writes `active` on the way in; no code path wrote `idle`, `stale` or
 * `archived` on the way out. So every worktree the fleet has ever made says
 * `active` for good, and cleanup answers "the fleet still has it marked
 * active" about every one of them — a whole module that cannot reach its own
 * first decision.
 *
 * The state column being wrong is the defect on its own, before any deletion
 * is on the table: a mission finished last month still claims to be holding
 * its directories open. This module is the half that makes the record true.
 * It moves nothing on disk and deletes nothing, ever. The reaper — the half
 * that actually runs `git worktree remove` — is deliberately not here, and
 * wants a preview and a human behind it when it comes.
 *
 * `stale` is not written either, and that is a decision rather than an
 * omission: `removalRoute` treats `idle` and `stale` identically, so a timer
 * that ages one into the other would buy the reaper nothing and cost a
 * threshold to argue about.
 */

/** What the fleet knows about the runs that might still want a directory. */
export interface RetireFacts {
  /** Tasks with a run alive. Something is writing into those worktrees now. */
  busyTaskIds: ReadonlySet<string>;
  /**
   * Tasks whose report has not been judged yet.
   *
   * Judging READS the worktree — the branch, the diff, the head, and the
   * mission's verify command run inside it. A run that has reported is done
   * with the directory, but the server is not, so retiring on `reported`
   * alone would mark a directory idle while the pulse was about to read it.
   */
  unreadTaskIds: ReadonlySet<string>;
}

export type RetireVerdict = { kind: 'retire'; reason: string } | { kind: 'hold'; reason: string };

/**
 * Whether one worktree is finished with, and may stop saying `active`.
 *
 * Holding is the safe direction and the default. Being wrong about a retire
 * costs nothing on disk today, but `idle` is what makes a record a cleanup
 * candidate at all — so a wrong answer here is the first step of a wrong
 * deletion later, and this is where that has to be stopped.
 */
export function retireWorktree(record: WorktreeRecord, facts: RetireFacts): RetireVerdict {
  if (record.state !== 'active') return { kind: 'hold', reason: `it is already ${record.state}` };
  // Both owner fields, matching `claimWorktree` and `cleanupWorktree`: the
  // schema sets them to NULL independently, and a record with one of them is
  // one something wrote halfway. An unowned record cannot be checked against
  // the run snapshot below, so it cannot be shown to be finished with.
  if (!record.ownerTaskId || !record.ownerMissionId) {
    return { kind: 'hold', reason: 'that worktree has no recorded owner' };
  }
  if (facts.busyTaskIds.has(record.ownerTaskId)) {
    return { kind: 'hold', reason: 'a run is using it right now' };
  }
  if (facts.unreadTaskIds.has(record.ownerTaskId)) {
    return { kind: 'hold', reason: 'its report has not been judged yet' };
  }
  return { kind: 'retire', reason: 'no run is using it' };
}

/**
 * What a retire pass would do, with its reasons.
 *
 * Shaped like `cleanupPlan` next door, and for the same argument: the useful
 * question about a worktree is usually "why is that one still held?".
 */
export function retirePlan(
  records: readonly WorktreeRecord[],
  facts: RetireFacts,
): Array<{ record: WorktreeRecord; verdict: RetireVerdict }> {
  return records.map((record) => ({ record, verdict: retireWorktree(record, facts) }));
}

/**
 * The pass itself: read the runs, decide, write `idle`.
 *
 * Returns how many were retired. A store read that fails retires nothing —
 * not knowing which runs are alive is exactly the case where the answer has
 * to be "hold", and answering it from a partial list would be worse than
 * skipping the pass until the next pulse.
 */
export function retireWorktrees(store: FleetStore, missionId: string): number {
  const facts = factsFor(store, missionId);
  if (!facts) return 0;
  const records = store.worktrees.listByMission(missionId);
  if (!records.ok) return 0;

  let retired = 0;
  for (const { record, verdict } of retirePlan(records.value, facts)) {
    if (verdict.kind !== 'retire') continue;
    // One at a time, and a refusal is one record's problem: a row somebody
    // moved between the read and the write is a race, not a reason to abandon
    // the other worktrees in the same mission.
    if (store.worktrees.setState(record.id, 'idle').ok) retired += 1;
  }
  return retired;
}

function factsFor(store: FleetStore, missionId: string): RetireFacts | undefined {
  const runs = store.runs.listByMission(missionId);
  if (!runs.ok) return undefined;
  const busyTaskIds = new Set<string>();
  const unreadTaskIds = new Set<string>();
  for (const run of runs.value) {
    if (run.state === 'dispatched' || run.state === 'running') busyTaskIds.add(run.taskId);
    // Unknown counts as UNREAD here, the opposite of `judgeReported`: being
    // wrong the other way lets go of the worktree holding the only evidence
    // for a claim nobody has read, and nothing puts a retired one back.
    else if (run.state === 'reported' && hasJudgement(store, run.taskId, run.id) !== true) {
      unreadTaskIds.add(run.taskId);
    }
  }
  return { busyTaskIds, unreadTaskIds };
}
