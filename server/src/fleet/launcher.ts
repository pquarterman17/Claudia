import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';
import type { AgentKind, PermissionLaunchMode, Task } from '@claudia/shared';
import type { FleetStore } from '../store/index.js';
import { ensureWorktree, worktreePath } from '../worktree.js';
import type { LaunchChild, LaunchOrder } from './pulse.js';
import { claimWorktree, type ObservedWorktree } from './worktree-owner.js';

const run = promisify(execFile);

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

/** Only `claude` is wired; `ChildRun.agent` exists for the day that changes. */
const CHILD_AGENT: AgentKind = 'claude';

export function createLauncher(deps: LauncherDeps): LaunchChild {
  return async (order: LaunchOrder): Promise<boolean> => {
    const task = deps.store.tasks.get(order.taskId);
    if (!task.ok) throw new Error(task.message);
    if (!task.value) throw new Error(`there is no task ${order.taskId} to run`);

    const path = await claimFor(order, task.value, deps);
    const sessionId = deps.startSession({
      cwd: path,
      agent: CHILD_AGENT,
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
    const running = deps.store.runs.setState(order.runId, 'running');
    if (!running.ok) {
      deps.stopSession(sessionId);
      throw new Error(`started a child but could not record it as running: ${running.message}`);
    }
    return true;
  };
}

/**
 * Acquires the worktree this task will work in, and answers with its path.
 *
 * The decision is `claimWorktree`'s, which is biased towards refusing: a wrong
 * `create` costs a directory, and a wrong reuse drops somebody's uncommitted
 * work into another agent's edit stream, which nothing afterwards can detect.
 * This carries out the verdict; it does not second-guess it.
 */
async function claimFor(order: LaunchOrder, task: Task, deps: LauncherDeps): Promise<string> {
  const repo = task.cwd;
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
    return path;
  }

  // `adopt`: the row is already this task's, and `path` is the legal route
  // from where it is back to `active`, every hop of it.
  const id = held.value?.id;
  if (!id) throw new Error('the worktree record vanished between reading it and claiming it');
  for (const state of verdict.path) {
    const moved = deps.store.worktrees.setState(id, state);
    if (!moved.ok) throw new Error(moved.message);
  }
  return path;
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

/** One line of git output, or `undefined` when the command could not answer. */
async function gitLine(cwd: string, args: string[], opts: { allowEmpty?: boolean } = {}): Promise<string | undefined> {
  try {
    const { stdout } = await run('git', args, { cwd, timeout: 10_000, windowsHide: true });
    const line = stdout.trim();
    return line || (opts.allowEmpty ? '' : undefined);
  } catch {
    return undefined;
  }
}
