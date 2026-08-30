import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GitCache, readGitInfo } from '../src/git-info.js';

/**
 * Spawns real git per test, and a Windows runner charges far more for each
 * spawn than a local machine does. The same 5s default put worktree.test.ts
 * red on windows-24 while every other job passed the same commit; this file
 * is the other one that shells out, so it gets the same headroom before it
 * finds that out on somebody else’s branch.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * Driven against real repositories rather than a mocked `git`, because the
 * thing worth testing is what the actual command prints — a mock would only
 * assert my assumptions about its output back at me.
 */

function repo(branch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'claudia-git-'));
  const run = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run(['init', '--initial-branch', branch]);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'a.txt'), 'hello');
  run(['add', '.']);
  run(['commit', '-m', 'first']);
  return dir;
}

describe('readGitInfo', () => {
  it('reports the branch a clean repository is on', async () => {
    const info = await readGitInfo(repo('main'));
    expect(info).toMatchObject({ branch: 'main', dirtyFiles: 0 });
  });

  it('reports the branch name that actually distinguishes parallel sessions', async () => {
    // The whole point: several sessions in one repo differ only by branch.
    const info = await readGitInfo(repo('feat/toolkit'));
    expect(info?.branch).toBe('feat/toolkit');
  });

  it('counts uncommitted files, including untracked ones', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'changed');
    writeFileSync(join(dir, 'b.txt'), 'new');
    const info = await readGitInfo(dir);
    expect(info?.dirtyFiles).toBe(2);
  });

  it('returns null for a directory that is not a repository', async () => {
    // Launching a session outside a repo is ordinary, not an error.
    expect(await readGitInfo(mkdtempSync(join(tmpdir(), 'claudia-plain-')))).toBeNull();
  });

  it('returns null rather than throwing for a directory that does not exist', async () => {
    // Reached from a websocket handler, where a rejection ends the process.
    await expect(readGitInfo(join(tmpdir(), 'claudia-does-not-exist-xyz'))).resolves.toBeNull();
  });
});

describe('GitCache', () => {
  it('reads a directory once and answers synchronously afterwards', async () => {
    const dir = repo('cached');
    const cache = new GitCache();
    expect(cache.get(dir)).toBeUndefined();
    await cache.refresh([dir]);
    // Synchronous by design: the session summary is rebuilt on every state
    // change and must never wait on a subprocess.
    expect(cache.get(dir)?.branch).toBe('cached');
  });

  it('forgets directories no session is watching any more', async () => {
    const [a, b] = [repo('a'), repo('b')];
    const cache = new GitCache();
    await cache.refresh([a, b]);
    await cache.refresh([a]);
    expect(cache.get(a)?.branch).toBe('a');
    expect(cache.get(b)).toBeUndefined();
  });

  it('deduplicates directories shared by several sessions', async () => {
    // Parallel sessions in one repo are the normal case; asking git the same
    // question once per session would be wasteful.
    const dir = repo('shared');
    const cache = new GitCache();
    await cache.refresh([dir, dir, dir]);
    expect(cache.get(dir)?.branch).toBe('shared');
  });
});
