import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitInfo } from '@claudia/shared';

const run = promisify(execFile);

/**
 * What branch a session's directory is on, and whether it has uncommitted work.
 *
 * This is identity, not decoration. Claudia labels a tile by its working
 * directory, but the owner's workflow is a branch per feature IN ONE REPO, so
 * three parallel sessions all read the same path and are indistinguishable at a
 * glance — which is the exact problem this app exists to solve.
 *
 * Never rejects. It is reached from a websocket handler, where an unhandled
 * rejection ends the process, and a directory that is not a repository is a
 * perfectly ordinary thing to launch a session in.
 */
export async function readGitInfo(cwd: string): Promise<GitInfo | null> {
  try {
    const [branch, status] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['status', '--porcelain']),
    ]);
    if (branch === null) return null;
    const dirtyFiles = status ? status.split('\n').filter((line) => line.trim() !== '').length : 0;
    return {
      // A detached HEAD reports "HEAD"; showing that is more honest than a sha
      // the user did not choose.
      branch: branch.trim() || 'detached',
      dirtyFiles,
    };
  } catch {
    return null;
  }
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    // execFile with an argument array: the directory is user-supplied and must
    // never reach a shell, matching every other subprocess in this codebase.
    const { stdout } = await run('git', args, { cwd, timeout: 5000, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

/**
 * The working-tree diff, for handing one agent another's actual work.
 *
 * Staged and unstaged together (`HEAD`), so a session that staged something
 * mid-task is still fully described. Untracked files are NOT included: git
 * cannot diff what it has never seen, and listing them by name is more useful
 * than pasting whole new files into a prompt.
 *
 * Bounded, and says so when it truncates. A diff is going into a prompt whose
 * budget belongs to somebody else's turn, and a silent cut would have the
 * reviewing agent confidently critique half a change.
 */
export async function readDiff(cwd: string, maxChars = 60_000): Promise<string | null> {
  const diff = await git(cwd, ['diff', 'HEAD']);
  if (diff === null) return null;
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])) ?? '';
  const names = untracked.split('\n').filter((n) => n.trim() !== '');
  const listed = names.length > 0 ? `\n\nUntracked files not shown in the diff:\n${names.map((n) => `- ${n}`).join('\n')}` : '';
  const body = diff.trim() === '' ? '(no tracked changes)' : diff;
  const full = `${body}${listed}`;
  if (full.length <= maxChars) return full;
  return `${full.slice(0, maxChars)}\n\n[diff truncated at ${maxChars} characters — ${full.length} in total]`;
}

/**
 * Git state cached per DIRECTORY, not per session.
 *
 * Several tiles routinely share one repository — that is the whole point of
 * running parallel sessions — so keying by session would spawn N `git`
 * processes for the same answer every refresh.
 */
export class GitCache {
  private readonly byDir = new Map<string, GitInfo | null>();

  /** Whatever was last read for this directory. Synchronous by design: the
   * session summary is built on every state change and must never wait on a
   * subprocess. */
  get(cwd: string): GitInfo | undefined {
    return this.byDir.get(cwd) ?? undefined;
  }

  /** Re-reads the given directories, deduped. Resolves when all have settled. */
  async refresh(cwds: readonly string[]): Promise<void> {
    const unique = [...new Set(cwds)];
    await Promise.all(
      unique.map(async (cwd) => {
        this.byDir.set(cwd, await readGitInfo(cwd));
      }),
    );
    // Forget directories with no live session, so a long-running server does
    // not accumulate state for repositories nobody is watching.
    for (const known of [...this.byDir.keys()]) {
      if (!unique.includes(known)) this.byDir.delete(known);
    }
  }
}
