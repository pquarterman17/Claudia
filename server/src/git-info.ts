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
