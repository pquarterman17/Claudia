import { realpathSync, statSync } from 'node:fs';
import type { AgentKind, PermissionLaunchMode, Task } from '@claudia/shared';
import type { FleetStore } from '../store/index.js';
import { gitLine } from './git-facts.js';
import { ensureWorktree, worktreePath } from '../worktree.js';
import type { LaunchChild, LaunchOrder } from './pulse.js';
import { claimWorktree, type ObservedWorktree } from './worktree-owner.js';

/**
 * Where a dispatch decision finally becomes a running agent.
 *
 * Everything either side of this has been in place for a while: the reconciler
 * decides, the pulse reserves the attempt durably, the watchdog supervises what
 * comes back, and recovery cleans up after a crash. This is the piece that was
 * a port with no implementation, so the fleet could decide and record and never
 * spend.
 *
 * It runs AFTER the pulse's transaction commits, which is what makes the
 * ordering safe: the run row already exists, so a child that starts is one the
 * file already describes, and a child that does not start is undone by the
 * compensating write the pulse makes when this reports failure.
 *
 * Failure is reported by THROWING with a reason rather than returning false.
 * Both are treated as "the launch did not happen", but the message reaches the
 * `launch_failed` note, and "another task owns that worktree" is worth having
 * in the log where returning false would have said only that the launcher
 * declined.
 */

export interface LauncherDeps {
  store: FleetStore;
  /** Starts a session and answers with its id, or `undefined` if it could not. */
  startSession(spec: {
    cwd: string;
    agent: AgentKind;
    prompt: string;
    permissionMode: PermissionLaunchMode;
  }): string | undefined;
  /** Stops a session this launcher started but could not keep. */
  stopSession(sessionId: string): void;
}

/**
 * `default`, not `acceptEdits` or `bypassPermissions`.
 *
 * A fleet child is unattended, which is the argument people usually make for
 * loosening this. It is the opposite argument here: `capabilities.ts` is built
 * on a child never granting itself a capability, and the watchdog already
 * treats a run parked on an approval as a `stuck` fault to ESCALATE to a human
 * rather than retry. Parking is therefore the designed behaviour, not a stall —
 * and a fleet that quietly accepted every edit would make the capability
 * boundary decorative.
 */
const CHILD_PERMISSIONS: PermissionLaunchMode = 'default';

export function createLauncher(deps: LauncherDeps): LaunchChild {
  return async (order: LaunchOrder): Promise<boolean> => {
    const task = deps.store.tasks.get(order.taskId);
    if (!task.ok) throw new Error(task.message);
    if (!task.value) throw new Error(`there is no task ${order.taskId} to run`);

    const claim = await claimFor(order, task.value, deps);
    const sessionId = deps.startSession({
      cwd: claim.path,
      // The reservation's answer, not a constant and not the mission's current
      // one: the run row is the record of what this attempt was authorised to
      // start, and it is what the watchdog and any retry will read back.
      agent: order.agent,
      prompt: briefFor(task.value),
      permissionMode: CHILD_PERMISSIONS,
    });
    if (sessionId === undefined) throw new Error('the session manager would not start a child');

    // The reservation may be gone: this whole function runs inside the starting
    // grace, and a slow worktree can outlast it. `attachSession` refuses in
    // that case, and the child has to be stopped — it is real, it is running,
    // and nothing else knows about it.
    const attached = deps.store.runs.attachSession(order.runId, sessionId);
    if (!attached.ok) {
      deps.stopSession(sessionId);
      throw new Error(`started a child but lost the reservation: ${attached.message}`);
    }
    // The other half of the same record, and it was never written. The
    // directory was made and the worktree row inserted, and then the id was
    // dropped on the floor — so `run.worktreeId` was undefined for every child
    // the fleet ever started, and `gatherEvidence` reads exactly that field.
    // Nothing could be observed about any finished run, and the acceptance
    // judgement it feeds returned `needs_human` with every fact missing.
    const owned = deps.store.runs.attachWorktree(order.runId, claim.worktreeId);
    if (!owned.ok) {
      deps.stopSession(sessionId);
      throw new Error(`started a child but could not record its worktree: ${owned.message}`);
    }
    const running = deps.store.runs.setState(order.runId, 'running');
    if (!running.ok) {
      deps.stopSession(sessionId);
      throw new Error(`started a child but could not record it as running: ${running.message}`);
    }
    return true;
  };
}

/** The worktree a run was given: where it works, and which row says so. */
interface Claim {
  path: string;
  worktreeId: string;
}

/**
 * Acquires the worktree this task will work in, and answers with its identity.
 *
 * The decision is `claimWorktree`'s, which is biased towards refusing: a wrong
 * `create` costs a directory, and a wrong reuse drops somebody's uncommitted
 * work into another agent's edit stream, which nothing afterwards can detect.
 * This carries out the verdict; it does not second-guess it.
 *
 * The ID, not just the path. Returning the path alone is what broke the
 * evidence: the caller could start a child in the right directory and still
 * have nothing to write on the run row, because the row that describes that
 * directory was never handed back.
 */
async function claimFor(order: LaunchOrder, task: Task, deps: LauncherDeps): Promise<Claim> {
  const repo = canonicalRepo(task.cwd);
  const branch = branchFor(task);
  const path = worktreePath(repo, branch);

  const held = deps.store.worktrees.byPath(path);
  if (!held.ok) throw new Error(held.message);
  const verdict = claimWorktree(
    { repo, path, branch, missionId: order.missionId, taskId: order.taskId },
    held.value,
    await observe(path),
  );
  if (verdict.kind === 'refuse') throw new Error(`cannot claim a worktree: ${verdict.reason}`);

  if (verdict.kind === 'create' || verdict.createDirectory) {
    const made = await ensureWorktree(repo, branch);
    if (!made.ok) throw new Error(made.message);
  }

  if (verdict.kind === 'create') {
    const record = deps.store.worktrees.create({
      repo,
      path,
      branch,
      baseSha: (await gitLine(path, ['rev-parse', 'HEAD'])) ?? '',
      ownerMissionId: order.missionId,
      ownerTaskId: order.taskId,
    });
    if (!record.ok) throw new Error(record.message);
    return { path, worktreeId: record.value.id };
  }

  // `adopt`: the row is already this task's, and `path` is the legal route
  // from where it is back to `active`, every hop of it.
  const id = held.value?.id;
  if (!id) throw new Error('the worktree record vanished between reading it and claiming it');
  for (const state of verdict.path) {
    const moved = deps.store.worktrees.setState(id, state);
    if (!moved.ok) throw new Error(moved.message);
  }
  return { path, worktreeId: id };
}

/**
 * The directory the task names, spelled the way git will answer.
 *
 * `claimWorktree` decides identity by comparing the repository git reports for
 * a worktree against the one on the record, and git RESOLVES the path before
 * answering. So a task whose cwd reaches the repository any other way created
 * its worktree once and could then never adopt it again: the record kept the
 * task's spelling, git kept the real one, and every retry was refused.
 *
 * Found on the Windows runner, where TEMP is an 8.3 short path
 * (`C:\Users\RUNNER~1\...`) and git answers with `runneradmin`; reproduced on
 * every platform with a symlink, which is the same fault. `samePath` cannot
 * close it — folding case and separators is string work, and only the
 * filesystem knows that two spellings name one directory.
 *
 * It also settles WHERE the worktree goes, which matters more: `worktreePath`
 * hangs a `-worktrees` directory off the repository's own name, so two
 * spellings of one checkout were getting two worktree trees and two live
 * claims — the collision `worktreePathKey` exists to prevent, arriving one
 * layer above it.
 *
 * Falls back to the given spelling when the path cannot be resolved, which
 * leaves the claim exactly as strict as it was: an unreadable path is not a
 * reason to guess, and `claimWorktree` refuses on mismatch anyway.
 */
function canonicalRepo(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

/**
 * A branch name derived from the task, so a retry lands on the same one.
 *
 * Derived rather than random for the same reason the reservation key is: two
 * attempts at one task are the same work, and a fresh branch each time would
 * scatter it. The id suffix is what keeps two tasks with the same title apart.
 */
export function branchFor(task: Pick<Task, 'id' | 'title'>): string {
  const slug = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `claudia/${slug || 'task'}-${task.id.slice(0, 8)}`;
}

/** What the child is told to do. */
export function briefFor(task: Task): string {
  const parts = [`# ${task.title}`, task.description];
  if (task.acceptance) parts.push(`## Done when\n\n${task.acceptance}`);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * What is actually at the path, as far as this process can tell.
 *
 * Every field is left UNDEFINED when it cannot be read, which `claimWorktree`
 * treats as a reason to refuse. That is the point: `exists: false` is the one
 * value that skips its identity, dirty and ownership vetoes, so a `statSync`
 * that failed for any reason other than "nothing there" must not be reported
 * as an empty path.
 */
async function observe(path: string): Promise<ObservedWorktree> {
  try {
    statSync(path);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { exists: false } : {};
  }
  const common = await gitLine(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const status = await gitLine(path, ['status', '--porcelain'], { allowEmpty: true });
  return {
    exists: true,
    ...(common ? { repo: common.replace(/[/\\]\.git\/?$/, '') } : {}),
    ...(await optional('branch', gitLine(path, ['rev-parse', '--abbrev-ref', 'HEAD']))),
    ...(await optional('headSha', gitLine(path, ['rev-parse', 'HEAD']))),
    ...(status === undefined ? {} : { dirty: status.length > 0 }),
  };
}

async function optional<K extends string>(key: K, value: Promise<string | undefined>): Promise<Record<K, string> | object> {
  const resolved = await value;
  return resolved ? ({ [key]: resolved } as Record<K, string>) : {};
}
