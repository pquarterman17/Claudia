import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorktreeRecord } from '@claudia/shared';
import { observeForCleanup } from './worktree-observe.js';
import { cleanupWorktree, type CleanupVerdict } from './worktree-owner.js';
import type { FleetStore } from '../store/index.js';

const run = promisify(execFile);

/**
 * The reaper: the half of worktree cleanup that touches the disk.
 *
 * `worktree-retire.ts` says this module "wants a preview and a human behind
 * it", and the plan is more explicit still — managed cleanup must preview
 * branches and worktrees, no task may delete a dirty or unmerged worktree
 * automatically, and fully autonomous destructive cleanup is a stated
 * non-goal. So nothing here runs on a pulse. `previewCleanup` answers what
 * WOULD happen and is safe to call whenever; `reapWorktrees` is reachable only
 * from a command a person sent, and removes only what a preview already
 * showed them.
 *
 * The decision is not made here either. `cleanupWorktree` grades a record
 * against an observation and this executes its verdict, so the rules about
 * ownership, identity, dirtiness and merge state stay in one pure function
 * with the tests that stage the cases that lose work.
 */

export interface ReapOutcome {
  record: WorktreeRecord;
  verdict: CleanupVerdict;
  /** Absent until something was attempted; `false` with a reason when git refused. */
  removed?: boolean;
  error?: string;
}

/**
 * What a cleanup would do right now, with a reason for every record.
 *
 * Reads git and never writes: the human's real question about a worktree is
 * "why is that one still here?", and answering it must not cost them anything.
 */
export async function previewCleanup(
  store: FleetStore,
  missionId: string,
  confirmedUnmerged?: ReadonlySet<string>,
): Promise<ReapOutcome[] | undefined> {
  const busyTaskIds = busyTasks(store, missionId);
  if (busyTaskIds === undefined) return undefined;
  const records = store.worktrees.listByMission(missionId);
  if (!records.ok) return undefined;

  const outcomes: ReapOutcome[] = [];
  for (const record of records.value) {
    // Sequential rather than `Promise.all`: each record costs four `git`
    // invocations, and a mission with a dozen worktrees would otherwise put
    // fifty processes on the box at once to answer a question nobody is
    // blocked on.
    const observed = await observeForCleanup(record);
    outcomes.push({ record, verdict: cleanupWorktree(record, observed, { busyTaskIds, ...(confirmedUnmerged ? { confirmedUnmerged } : {}) }) });
  }
  return outcomes;
}

/**
 * Remove the worktrees a person asked for, and only those.
 *
 * `chosen` is the ids they clicked, not a filter to apply afterwards: a
 * preview they read and a plan recomputed a minute later are not the same
 * list, and the record that appeared in between is one nobody agreed to.
 * Every id is still re-graded here — the preview is what they consented to,
 * not evidence about the disk, and a run may have claimed a directory since.
 */
export async function reapWorktrees(
  store: FleetStore,
  missionId: string,
  chosen: ReadonlySet<string>,
  confirmedUnmerged?: ReadonlySet<string>,
): Promise<ReapOutcome[] | undefined> {
  const planned = await previewCleanup(store, missionId, confirmedUnmerged);
  if (planned === undefined) return undefined;

  const outcomes: ReapOutcome[] = [];
  for (const outcome of planned) {
    if (!chosen.has(outcome.record.id) || outcome.verdict.kind !== 'remove') continue;
    outcomes.push(await reapOne(store, outcome.record, outcome.verdict));
  }
  return outcomes;
}

/**
 * Disk first, then the record.
 *
 * The other order loses the ability to try again: `worktrees_live_path` exempts
 * `removed`, so writing the row first frees the path for a new record while a
 * directory that git refused to delete is still sitting on it. Removing first
 * and failing to write leaves a record whose next preview observes
 * `exists: false` and removes it — an inconsistency that repairs itself.
 */
async function reapOne(store: FleetStore, record: WorktreeRecord, verdict: CleanupVerdict & { kind: 'remove' }): Promise<ReapOutcome> {
  const error = await removeOnDisk(record);
  if (error !== undefined) return { record, verdict, removed: false, error };
  // In order, every hop: `removed` is reachable only from `archived`, and
  // writing the last element alone is the refusal `CleanupVerdict.path` exists
  // to prevent.
  for (const state of verdict.path) {
    const written = store.worktrees.setState(record.id, state);
    if (!written.ok) return { record, verdict, removed: true, error: written.message };
  }
  return { record, verdict, removed: true };
}

/**
 * `git worktree remove`, and never with `--force`.
 *
 * Force is what makes this command delete uncommitted work, and the veto that
 * stops that lives in `cleanupWorktree` — a flag here would route around it.
 * If git refuses, the refusal is the answer: a worktree it will not let go of
 * is one this process should not be arguing with.
 */
async function removeOnDisk(record: WorktreeRecord): Promise<string | undefined> {
  try {
    await run('git', ['worktree', 'remove', record.path], { cwd: record.repo, timeout: 60_000, windowsHide: true });
    return undefined;
  } catch (err) {
    // The directory being gone already is the one failure that is not one:
    // `cleanupWorktree` returns `remove` for an absent path specifically to
    // clear the record, and git rightly refuses to remove what is not there.
    // `prune` makes git's own bookkeeping agree, and its failure is not fatal.
    if (missingPath(err)) {
      await run('git', ['worktree', 'prune'], { cwd: record.repo, timeout: 30_000, windowsHide: true }).catch(() => undefined);
      return undefined;
    }
    return gitComplaint(err);
  }
}

function missingPath(err: unknown): boolean {
  const stderr = (err as { stderr?: string } | null)?.stderr;
  return typeof stderr === 'string' && /is not a working tree|No such file or directory|not a valid path/i.test(stderr);
}

/** git puts the useful part on stderr; the exit code alone says nothing. */
function gitComplaint(err: unknown): string {
  const stderr = (err as { stderr?: string } | null)?.stderr;
  const first = typeof stderr === 'string' ? stderr.split('\n').find((line) => line.trim()) : undefined;
  return first?.replace(/^fatal:\s*/, '').trim() || 'git could not remove the worktree.';
}

/**
 * Tasks with a run alive right now.
 *
 * `undefined` rather than an empty set when the runs cannot be read, and every
 * caller here abandons the pass on it: `cleanupWorktree` requires this set and
 * documents why — a caller that simply had no snapshot got the same answer as
 * one that looked and found nothing, and a worktree in active use was removed
 * for being clean and merged.
 */
function busyTasks(store: FleetStore, missionId: string): ReadonlySet<string> | undefined {
  const runs = store.runs.listByMission(missionId);
  if (!runs.ok) return undefined;
  const busy = new Set<string>();
  for (const run of runs.value) {
    if (run.state === 'dispatched' || run.state === 'running') busy.add(run.taskId);
  }
  return busy;
}
