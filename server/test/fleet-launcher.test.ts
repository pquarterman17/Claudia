import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { branchFor, briefFor, createLauncher } from '../src/fleet/launcher.js';
import { pulseFleet, type LaunchOrder } from '../src/fleet/pulse.js';
import type { FleetStore } from '../src/store/index.js';
import { worktreePath } from '../src/worktree.js';

/**
 * The seam where a decision becomes a running agent.
 *
 * Driven against a REAL git repository rather than a mocked one: the whole
 * point of this module is the two things it joins — `git worktree add` and the
 * store's ownership rules — and a fake for either would prove only that the
 * calls were made in order.
 *
 * The session manager IS faked, because starting a Claude session is the one
 * part with no business running in a test.
 */

const dir = mkdtempSync(join(tmpdir(), 'claudia-launcher-'));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

let counter = 0;
/** A repository with one commit, a fleet store, a mission and a ready task. */
function bare() {
  const id = counter++;
  const repo = join(dir, `repo-${id}`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true });
  git(repo, 'config', 'user.email', 'fleet@example.com');
  git(repo, 'config', 'user.name', 'Fleet');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-qm', 'first');

  const boot = startFleet(new Set(), join(dir, `db-${id}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  const store = boot.store;
  opened.push(store);

  const mission = store.missions.create({ name: 'm', body: '', cwd: repo });
  if (!mission.ok) throw new Error(mission.message);
  const task = store.tasks.create({
    missionId: mission.value.id,
    title: 'Rename the thing',
    description: 'Rename it everywhere.',
    cwd: repo,
    acceptance: 'No references to the old name remain.',
  });
  if (!task.ok) throw new Error(task.message);
  return { repo, store, task: task.value, missionId: mission.value.id };
}

/**
 * `bare()` plus a reservation, which is what the pulse would have written.
 *
 * The two are separate because the difference is load-bearing: attempts are
 * counted over every run a task has ever had, finished ones included, so a
 * fixture that pre-spends attempt 1 makes the first real dispatch attempt 2.
 * The chain tests need a genuinely fresh task; the unit tests need an order to
 * hand the launcher directly.
 */
function fixture() {
  const { repo, store, task, missionId } = bare();
  const mission = { value: { id: missionId } };
  const run = store.runs.create({
    missionId: mission.value.id,
    taskId: task.id,
    agent: 'claude',
    attempt: 1,
    state: 'dispatched',
  });
  if (!run.ok) throw new Error(run.message);

  const order: LaunchOrder = {
    missionId: mission.value.id,
    taskId: task.id,
    runId: run.value.id,
    attempt: 1,
    key: 'dispatch:1',
  };
  return { repo, store, task, order, missionId: mission.value.id };
}

/** A session manager that records what it was asked to do. */
function fakeManager(over: { fail?: boolean } = {}) {
  const started: Array<{ cwd: string; prompt: string; permissionMode: string }> = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    startSession: (spec: { cwd: string; prompt: string; permissionMode: string }) => {
      started.push(spec);
      return over.fail ? undefined : `sess-${started.length}`;
    },
    stopSession: (id: string) => void stopped.push(id),
  };
}

describe('starting a child for a dispatched task', () => {
  it('creates the worktree, starts the session, and records both', async () => {
    const { repo, store, task, order } = fixture();
    const manager = fakeManager();
    const launch = createLauncher({ store, ...manager });

    await expect(launch(order)).resolves.toBe(true);

    // A real worktree on a real branch.
    const branch = branchFor(task);
    const path = worktreePath(repo, branch);
    expect(existsSync(path)).toBe(true);
    expect(git(path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);

    // Owned, in the store, by this task.
    const held = store.worktrees.byPath(path);
    if (!held.ok) throw new Error(held.message);
    expect(held.value?.ownerTaskId).toBe(task.id);
    expect(held.value?.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));

    // And the reservation now knows which session it got.
    const run = store.runs.get(order.runId);
    if (!run.ok) throw new Error(run.message);
    expect(run.value?.sessionId).toBe('sess-1');
    expect(run.value?.state).toBe('running');

    // The child was started in the worktree, not in the repository itself.
    expect(manager.started[0]?.cwd).toBe(path);
    expect(manager.started[0]?.permissionMode).toBe('default');
  });

  it('refuses to take a worktree another task owns', async () => {
    // The collision the whole ownership scheme exists to prevent. A clean
    // worktree on somebody else's branch is still their branch, and two tasks
    // sharing one is unrecoverable: nothing afterwards can tell you whose
    // uncommitted work ended up in whose edit stream.
    const { repo, store, task, order, missionId } = fixture();
    // A real rival: the worktree record carries foreign keys, so an owner that
    // does not exist would be refused by the schema rather than by the rule
    // under test.
    const rival = store.tasks.create({ missionId, title: 'Something else', description: '', cwd: repo });
    if (!rival.ok) throw new Error(rival.message);
    const path = worktreePath(repo, branchFor(task));
    const theirs = store.worktrees.create({
      repo,
      path,
      branch: branchFor(task),
      baseSha: git(repo, 'rev-parse', 'HEAD'),
      ownerMissionId: missionId,
      ownerTaskId: rival.value.id,
    });
    if (!theirs.ok) throw new Error(theirs.message);

    const manager = fakeManager();
    const launch = createLauncher({ store, ...manager });
    await expect(launch(order)).rejects.toThrow(/another task owns/);
    // And nothing was started, so there is no child to clean up.
    expect(manager.started).toEqual([]);
  });

  it('reports a launch that never started, without touching the reservation', async () => {
    const { store, order } = fixture();
    const manager = fakeManager({ fail: true });
    const launch = createLauncher({ store, ...manager });

    await expect(launch(order)).rejects.toThrow(/would not start/);
    const run = store.runs.get(order.runId);
    if (!run.ok) throw new Error(run.message);
    // Untouched: the pulse's compensating write is what retires it, and it
    // needs the row exactly as it left it.
    expect(run.value?.sessionId).toBeUndefined();
    expect(run.value?.state).toBe('dispatched');
  });

  it('stops the child when the reservation was retired while it was starting', async () => {
    // The case `attachSession`'s refusal exists for. The grace expired, a later
    // pulse failed this run, and the launcher is holding a real child that
    // nothing will ever supervise.
    const { store, order } = fixture();
    const manager = fakeManager();
    const launch = createLauncher({ store, ...manager });
    const retired = store.runs.setState(order.runId, 'failed', { terminalReason: 'took too long' });
    if (!retired.ok) throw new Error(retired.message);

    await expect(launch(order)).rejects.toThrow(/lost the reservation/);
    // Started, then stopped — not left running with nobody watching it.
    expect(manager.started).toHaveLength(1);
    expect(manager.stopped).toEqual(['sess-1']);
  });

  it('gives the child the task, not just its title', () => {
    const { task } = fixture();
    const brief = briefFor(task);
    expect(brief).toContain('Rename the thing');
    expect(brief).toContain('Rename it everywhere.');
    expect(brief).toContain('No references to the old name remain.');
  });

  it('derives the same branch for every attempt at one task', () => {
    const { task } = fixture();
    expect(branchFor(task)).toBe(branchFor(task));
    expect(branchFor(task)).toMatch(/^claudia\/rename-the-thing-[0-9a-f]{8}$/);
  });
});

describe('the whole chain, from a decision to a running child', () => {
  /**
   * Everything real except the SDK: a real git repository, a real store, the
   * real reconciler, the real pulse, and the real launcher. Only starting a
   * Claude session is faked.
   *
   * This is the test the unit tests could not be. Each half was proved against
   * its own fixture, and the halves were written weeks apart — the reservation
   * in one PR, the launcher in another — so what had never been exercised was
   * the join: a decision becoming a reserved row becoming a worktree becoming
   * a session id back on that same row.
   */
  it('dispatches a ready task and comes back with a supervised run', async () => {
    const { repo, store, task, missionId } = bare();
    // The pulse only acts on a mission somebody is watching.
    const watched = store.missions.setWatch(missionId, 'watching');
    if (!watched.ok) throw new Error(watched.message);
    const ready = store.tasks.setStatus(task.id, 'ready');
    if (!ready.ok) throw new Error(ready.message);

    const manager = fakeManager();
    const [result] = await pulseFleet({
      store,
      policy: { maxChildren: 2, maxAttempts: 3 },
      launch: createLauncher({ store, ...manager }),
      observeSessions: () => new Map(),
    });

    expect(result?.launched).toBe(1);
    expect(result?.deferred).toBe(0);

    // One run, reserved by the pulse and completed by the launcher.
    const after = store.runs.listByMission(missionId);
    if (!after.ok) throw new Error(after.message);
    const live = after.value.filter((r) => r.state === 'running');
    expect(live).toHaveLength(1);
    expect(live[0]?.sessionId).toBe('sess-1');
    expect(live[0]?.attempt).toBe(1);

    // The task is running, not still queued.
    const moved = store.tasks.get(task.id);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.value?.status).toBe('running');

    // A real worktree, owned by this task.
    const path = worktreePath(repo, branchFor(task));
    expect(existsSync(path)).toBe(true);
    const held = store.worktrees.byPath(path);
    if (!held.ok) throw new Error(held.message);
    expect(held.value?.ownerTaskId).toBe(task.id);
    expect(manager.started[0]?.cwd).toBe(path);
  });

  it('does not dispatch the same task twice across two pulses', async () => {
    // The duplicate-spend hazard the reservation exists for, end to end rather
    // than against a stubbed launcher.
    const { store, task, missionId } = bare();
    const watched = store.missions.setWatch(missionId, 'watching');
    if (!watched.ok) throw new Error(watched.message);
    const ready = store.tasks.setStatus(task.id, 'ready');
    if (!ready.ok) throw new Error(ready.message);

    const manager = fakeManager();
    const deps = {
      store,
      policy: { maxChildren: 2, maxAttempts: 3 },
      launch: createLauncher({ store, ...manager }),
      // The child it just started is alive, so the watchdog leaves it be.
      observeSessions: () => new Map([['sess-1', { lastActivityAt: Date.now() }]]),
    };
    await pulseFleet(deps);
    await pulseFleet(deps);

    expect(manager.started).toHaveLength(1);
  });
});

describe('a fleet child outlives the browser', () => {
  it('is listed as active so the idle reaper leaves it alone', async () => {
    // Found by running the fleet for real. A mission dispatched a task, the
    // child started, the driver disconnected, and thirty seconds later the
    // browser-idle reaper stopped the very work the fleet had just paid to
    // begin — because it exempts orchestrator sessions and knew nothing about
    // fleet ones. Unattended is what a fleet IS.
    const { store, task, missionId } = bare();
    const watched = store.missions.setWatch(missionId, 'watching');
    if (!watched.ok) throw new Error(watched.message);
    const ready = store.tasks.setStatus(task.id, 'ready');
    if (!ready.ok) throw new Error(ready.message);

    const manager = fakeManager();
    await pulseFleet({
      store,
      policy: { maxChildren: 2, maxAttempts: 3 },
      launch: createLauncher({ store, ...manager }),
      observeSessions: () => new Map(),
    });

    const active = store.runs.listActive();
    if (!active.ok) throw new Error(active.message);
    expect(active.value.map((r) => r.sessionId)).toEqual(['sess-1']);
  });

  it('stops counting a run once it has finished', async () => {
    const { store, order } = fixture();
    const before = store.runs.listActive();
    if (!before.ok) throw new Error(before.message);
    expect(before.value).toHaveLength(1);

    const ended = store.runs.setState(order.runId, 'stopped', { terminalReason: 'done' });
    if (!ended.ok) throw new Error(ended.message);
    const after = store.runs.listActive();
    if (!after.ok) throw new Error(after.message);
    expect(after.value).toEqual([]);
  });
});
