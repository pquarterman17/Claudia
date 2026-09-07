import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { startFleet } from '../src/fleet/boot.js';
import { observeForCleanup } from '../src/fleet/worktree-observe.js';
import { previewCleanup, reapWorktrees } from '../src/fleet/worktree-reap.js';
import type { FleetStore } from '../src/store/index.js';

/**
 * The half of worktree cleanup that touches the disk.
 *
 * Real repositories and real worktrees throughout, because every interesting
 * case here is git's answer rather than ours: whether a branch's commits exist
 * anywhere else, whether a tree is clean, and whether `git worktree remove`
 * agrees to let go. A fake would only test the fake.
 *
 * The rules themselves live in `cleanupWorktree` and are tested next door
 * against staged observations. What is tested here is that the observation is
 * true, that the executor obeys the verdict, and that a person's choice is
 * what decides which directories go.
 */

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'claudia-reap-')));
const opened: FleetStore[] = [];
afterAll(() => {
  for (const store of opened) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let counter = 0;

function repo(): string {
  const path = join(dir, `repo-${counter++}`);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'test@example.com');
  git(path, 'config', 'user.name', 'Test');
  writeFileSync(join(path, 'README.md'), '# base\n', 'utf8');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-q', '-m', 'base');
  return path;
}

function store(): FleetStore {
  const boot = startFleet(new Set(), join(dir, `db-${counter++}`, 'fleet.db'));
  if (!boot.store) throw new Error(boot.summary);
  opened.push(boot.store);
  return boot.store;
}

/**
 * A mission, a task and a worktree that all point at each other.
 *
 * `cleanupWorktree` refuses a record missing either owner field, so a fixture
 * that skipped one would test the refusal rather than the removal.
 */
function fleetWith(repoPath: string, branch: string): { store: FleetStore; missionId: string; taskId: string; worktreeId: string; path: string } {
  const s = store();
  const mission = s.missions.create({ name: 'M', body: '', cwd: repoPath, agent: 'claude' });
  if (!mission.ok) throw new Error(mission.message);
  const task = s.tasks.create({ missionId: mission.value.id, title: 'T', description: '', cwd: repoPath, acceptance: '' });
  if (!task.ok) throw new Error(task.message);
  const path = join(dir, `wt-${counter++}`);
  git(repoPath, 'worktree', 'add', '-q', '-b', branch, path);
  const worktree = s.worktrees.create({
    repo: repoPath,
    path,
    branch,
    baseSha: git(repoPath, 'rev-parse', 'HEAD'),
    ownerMissionId: mission.value.id,
    ownerTaskId: task.value.id,
  });
  if (!worktree.ok) throw new Error(worktree.message);
  return { store: s, missionId: mission.value.id, taskId: task.value.id, worktreeId: worktree.value.id, path };
}

/** `cleanupWorktree` keeps anything still marked active; retiring is a separate pass. */
function retire(s: FleetStore, worktreeId: string): void {
  const moved = s.worktrees.setState(worktreeId, 'idle');
  if (!moved.ok) throw new Error(moved.message);
}

describe('observing a worktree for cleanup', () => {
  it('calls a branch with no commits of its own merged', async () => {
    // Nothing to lose: the tip is still the base it was cut from. Checked
    // before `--is-ancestor` because a fresh worktree is exactly the case that
    // question is least able to answer.
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/fresh');
    const record = fleet.store.worktrees.get(fleet.worktreeId);
    if (!record.ok || !record.value) throw new Error('no record');
    expect(await observeForCleanup(record.value)).toMatchObject({ exists: true, dirty: false, merged: true });
  });

  it('calls a branch with unmerged commits unmerged', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/ahead');
    writeFileSync(join(fleet.path, 'work.txt'), 'work\n', 'utf8');
    git(fleet.path, 'add', 'work.txt');
    git(fleet.path, 'commit', '-q', '-m', 'work');
    const record = fleet.store.worktrees.get(fleet.worktreeId);
    if (!record.ok || !record.value) throw new Error('no record');
    expect(await observeForCleanup(record.value)).toMatchObject({ merged: false, dirty: false });
  });

  it('reports uncommitted work as dirty', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/dirty');
    writeFileSync(join(fleet.path, 'scratch.txt'), 'unsaved\n', 'utf8');
    const record = fleet.store.worktrees.get(fleet.worktreeId);
    if (!record.ok || !record.value) throw new Error('no record');
    expect((await observeForCleanup(record.value)).dirty).toBe(true);
  });

  it('says nothing rather than guessing about a path that is gone', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/vanished');
    rmSync(fleet.path, { recursive: true, force: true });
    const record = fleet.store.worktrees.get(fleet.worktreeId);
    if (!record.ok || !record.value) throw new Error('no record');
    expect(await observeForCleanup(record.value)).toEqual({ exists: false });
  });
});

describe('previewing a cleanup', () => {
  it('explains the ones it is keeping, not only the ones it would take', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/held');
    const plan = await previewCleanup(fleet.store, fleet.missionId);
    expect(plan).toHaveLength(1);
    expect(plan?.[0]).toMatchObject({ verdict: { kind: 'keep', reason: 'the fleet still has it marked active' } });
  });

  it('writes nothing, so the directory is still there afterwards', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/untouched');
    retire(fleet.store, fleet.worktreeId);
    await previewCleanup(fleet.store, fleet.missionId);
    expect(existsSync(fleet.path)).toBe(true);
  });
});

describe('removing worktrees', () => {
  it('removes a clean, merged, retired worktree and records it', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/done');
    retire(fleet.store, fleet.worktreeId);
    const outcomes = await reapWorktrees(fleet.store, fleet.missionId, new Set([fleet.worktreeId]));
    expect(outcomes).toHaveLength(1);
    expect(outcomes?.[0]).toMatchObject({ removed: true });
    expect(existsSync(fleet.path)).toBe(false);
    const after = fleet.store.worktrees.get(fleet.worktreeId);
    expect(after.ok && after.value?.state).toBe('removed');
  });

  it('leaves a worktree nobody chose alone', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/spared');
    retire(fleet.store, fleet.worktreeId);
    expect(await reapWorktrees(fleet.store, fleet.missionId, new Set(['some-other-id']))).toEqual([]);
    expect(existsSync(fleet.path)).toBe(true);
  });

  it('refuses an unmerged branch even when it was chosen', async () => {
    // The choice is consent to the plan, not an override of it. Confirming an
    // unmerged removal is a separate, per-worktree act.
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/ahead-chosen');
    writeFileSync(join(fleet.path, 'work.txt'), 'work\n', 'utf8');
    git(fleet.path, 'add', 'work.txt');
    git(fleet.path, 'commit', '-q', '-m', 'work');
    retire(fleet.store, fleet.worktreeId);
    expect(await reapWorktrees(fleet.store, fleet.missionId, new Set([fleet.worktreeId]))).toEqual([]);
    expect(existsSync(fleet.path)).toBe(true);
  });

  it('removes that same unmerged branch once it is confirmed by id', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/ahead-confirmed');
    writeFileSync(join(fleet.path, 'work.txt'), 'work\n', 'utf8');
    git(fleet.path, 'add', 'work.txt');
    git(fleet.path, 'commit', '-q', '-m', 'work');
    retire(fleet.store, fleet.worktreeId);
    const outcomes = await reapWorktrees(fleet.store, fleet.missionId, new Set([fleet.worktreeId]), new Set([fleet.worktreeId]));
    expect(outcomes?.[0]).toMatchObject({ removed: true });
    expect(existsSync(fleet.path)).toBe(false);
  });

  it('never removes uncommitted work', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/dirty-chosen');
    writeFileSync(join(fleet.path, 'scratch.txt'), 'unsaved\n', 'utf8');
    retire(fleet.store, fleet.worktreeId);
    // Confirmed AND chosen: confirmation is about the merge veto, and must not
    // reach past it to the one that protects an afternoon of edits.
    expect(await reapWorktrees(fleet.store, fleet.missionId, new Set([fleet.worktreeId]), new Set([fleet.worktreeId]))).toEqual([]);
    expect(existsSync(join(fleet.path, 'scratch.txt'))).toBe(true);
  });

  it('clears the record for a directory that is already gone', async () => {
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/vanished-record');
    retire(fleet.store, fleet.worktreeId);
    rmSync(fleet.path, { recursive: true, force: true });
    const outcomes = await reapWorktrees(fleet.store, fleet.missionId, new Set([fleet.worktreeId]));
    expect(outcomes?.[0]).toMatchObject({ removed: true, verdict: { reason: 'the directory is already gone; clearing the record' } });
    const after = fleet.store.worktrees.get(fleet.worktreeId);
    expect(after.ok && after.value?.state).toBe('removed');
  });

  it('leaves the record alone when the mission still has it active', async () => {
    // No retire pass has run, so nothing here is a candidate — the same first
    // check `cleanupWorktree` makes, reached through the executor.
    const repoPath = repo();
    const fleet = fleetWith(repoPath, 'claudia/still-active');
    expect(await reapWorktrees(fleet.store, fleet.missionId, new Set([fleet.worktreeId]))).toEqual([]);
    expect(existsSync(fleet.path)).toBe(true);
  });
});
