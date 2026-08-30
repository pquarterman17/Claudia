import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Creates git worktrees so a session can work on its own branch without
 * disturbing the checkout you are looking at.
 *
 * Worktrees are never removed from here. One can hold hours of uncommitted
 * work, and a supervisor that tidies them up on session close would eventually
 * throw away something that mattered. Removing one is `git worktree remove`,
 * deliberately, by a human.
 */

export interface WorktreeResult {
  ok: true;
  path: string;
  branch: string;
  /** False when the worktree already existed and was reused. */
  created: boolean;
}

export interface WorktreeFailure {
  ok: false;
  message: string;
}

/** A safe directory component: no separators, no traversal, no oddities. */
export function worktreeDirName(branch: string): string {
  // A branch legitimately contains "/", which cannot become a directory level
  // or "feat/x" and "feat" would collide in the filesystem.
  return branch.replace(/[/\\:<>"|?*]+/g, '-').replace(/^[.-]+/, '') || 'work';
}

/**
 * Where a worktree for `branch` lives: a sibling of the repository, not inside
 * it. Inside would mean every tool that walks the project — including the agent
 * working in it — sees a second copy of the whole tree.
 */
export function worktreePath(repo: string, branch: string): string {
  const root = resolve(repo);
  return join(dirname(root), `${basename(root)}-worktrees`, worktreeDirName(branch));
}

/**
 * Ensures a worktree exists for `branch` and returns its path.
 *
 * Reuses an existing one rather than failing, so relaunching a session on the
 * same branch lands back in the work already there. Reports failure as a value:
 * this is reached from a websocket handler, where an unhandled rejection ends
 * the process.
 */
export async function ensureWorktree(repo: string, branch: string): Promise<WorktreeResult | WorktreeFailure> {
  const trimmed = branch.trim();
  if (!trimmed) return { ok: false, message: 'A branch name is required.' };
  if (/[\s~^:?*[\\]/.test(trimmed)) {
    return { ok: false, message: `"${trimmed}" is not a valid branch name.` };
  }

  const path = worktreePath(repo, trimmed);
  if (existsSync(path)) return { ok: true, path, branch: trimmed, created: false };

  const exists = await branchExists(repo, trimmed);
  // Checking out an existing branch, versus starting one from the current HEAD.
  const args = exists
    ? ['worktree', 'add', path, trimmed]
    : ['worktree', 'add', '-b', trimmed, path];

  try {
    await run('git', args, { cwd: repo, timeout: 60_000, windowsHide: true });
    return { ok: true, path, branch: trimmed, created: true };
  } catch (err) {
    return { ok: false, message: describeGitFailure(err) };
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--verify', `refs/heads/${branch}`], {
      cwd: repo,
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/** git puts the useful part on stderr; the exit code alone says nothing. */
function describeGitFailure(err: unknown): string {
  const stderr = (err as { stderr?: string } | null)?.stderr;
  const first = typeof stderr === 'string' ? stderr.split('\n').find((l) => l.trim()) : undefined;
  return first?.replace(/^fatal:\s*/, '') ?? 'git could not create the worktree.';
}
