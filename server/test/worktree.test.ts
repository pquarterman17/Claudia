import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ensureWorktree, worktreeDirName, worktreePath } from '../src/worktree.js';

/**
 * Every test here spawns real git several times — init, commit, branch,
 * worktree add — and on a Windows runner each spawn costs far more than it
 * does locally. Vitest's 5s default is a stopwatch on the runner's process
 * creation, not on anything this code does, and it went red on windows-24
 * while windows-22 and both Ubuntu jobs passed the same commit.
 *
 * Same treatment commit-action.test.ts already needed for the same reason.
 * Sizing the timeout for the slowest platform, rather than skipping the test,
 * is the only honest option: the assertion is still the assertion.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** A real repository with one commit, so `git worktree` has something to branch from. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-wt-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run(['init', '--initial-branch', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'hello');
  run(['add', '.']);
  run(['commit', '-m', 'first']);
  return dir;
}

describe('worktreeDirName', () => {
  it('flattens the slashes in a branch name', () => {
    // A branch legitimately contains "/", which must not become a directory
    // level, or "feat/x" and "feat" would collide in the filesystem.
    expect(worktreeDirName('feat/toolkit')).toBe('feat-toolkit');
  });

  it('strips characters a path cannot hold', () => {
    expect(worktreeDirName('fix/a:b|c?')).toBe('fix-a-b-c-');
  });

  it('never returns something that climbs out of its parent', () => {
    expect(worktreeDirName('../../etc')).not.toContain('..');
  });

  it('falls back to a name rather than an empty string', () => {
    expect(worktreeDirName('///')).toBe('work');
  });
});

describe('worktreePath', () => {
  it('places worktrees beside the repository, never inside it', () => {
    // Inside would mean every tool walking the project — including the agent
    // working in it — sees a second copy of the whole tree.
    const dir = repo();
    const path = worktreePath(dir, 'feat/x');
    expect(path.startsWith(dir + '\\') || path.startsWith(dir + '/')).toBe(false);
    expect(dirname(dirname(path))).toBe(dirname(dir));
    expect(basename(dirname(path))).toBe(`${basename(dir)}-worktrees`);
  });
});

describe('ensureWorktree', () => {
  it('creates a worktree on a new branch', async () => {
    const dir = repo();
    const result = await ensureWorktree(dir, 'feat/new-thing');
    expect(result).toMatchObject({ ok: true, branch: 'feat/new-thing', created: true });
    if (result.ok) {
      expect(existsSync(result.path)).toBe(true);
      expect(existsSync(join(result.path, 'a.txt'))).toBe(true);
    }
  });

  it('reuses an existing worktree instead of failing', async () => {
    // Relaunching a session on the same branch should land back in the work
    // already there.
    const dir = repo();
    const first = await ensureWorktree(dir, 'feat/reuse');
    const second = await ensureWorktree(dir, 'feat/reuse');
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) expect(second.path).toBe(first.path);
  });

  it('checks out a branch that already exists rather than trying to create it', async () => {
    const dir = repo();
    execFileSync('git', ['branch', 'existing'], { cwd: dir, stdio: 'ignore' });
    const result = await ensureWorktree(dir, 'existing');
    expect(result.ok).toBe(true);
  });

  it('reports a bad branch name as a value, not an exception', async () => {
    // Reached from a websocket handler, where a rejection ends the process.
    const result = await ensureWorktree(repo(), 'not a branch~name');
    expect(result).toMatchObject({ ok: false });
  });

  it('requires a branch name', async () => {
    expect(await ensureWorktree(repo(), '   ')).toMatchObject({ ok: false });
  });

  it('reports git failure with git own words', async () => {
    const notARepo = mkdtempSync(join(tmpdir(), 'claudia-plain-'));
    const result = await ensureWorktree(notARepo, 'feat/x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});
