import type { ClientCommand } from '@claudia/shared';
import { assertUsableDirectory, normalizePath } from './folder-picker.js';
import type { SessionManager } from './session-manager.js';
import { ensureWorktree } from './worktree.js';
import type { SettingsStore } from './settings-store.js';

/**
 * Resolves a launch/resume command into LaunchOptions and starts the session.
 *
 * Split out of gateway.ts's dispatch switch so the defaulting rules (agent,
 * permission mode, effort, thinking) live in one testable place — this is
 * also the one spot that decides which agent a new session runs, so launch
 * and resume cannot drift apart on it.
 */
export async function launchSession(
  cmd: Extract<ClientCommand, { type: 'launch_session' }>,
  manager: SessionManager,
  settings: SettingsStore,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const repo = normalizePath(cmd.cwd);
  assertUsableDirectory(repo);

  // A worktree launch runs the session on its own branch in its own directory,
  // leaving the checkout the user is looking at untouched. Reusing an existing
  // one is deliberate: relaunching on the same branch should land back in the
  // work already there, not fail.
  let cwd = repo;
  if (cmd.worktreeBranch?.trim()) {
    const tree = await ensureWorktree(repo, cmd.worktreeBranch);
    if (!tree.ok) return tree;
    cwd = tree.path;
  }

  manager.launch({
    cwd,
    agent: cmd.agent ?? 'claude',
    prompt: cmd.prompt,
    model: cmd.model,
    permissionMode: cmd.permissionMode ?? 'auto',
    effortLevel: cmd.effortLevel ?? 'high',
    thinkingMode: cmd.thinkingMode ?? 'adaptive',
  });
  // Remember the repository, not the worktree: the worktree is derived from it
  // and offering a list of them back would bury the repo you actually work in.
  settings.rememberDirectory(repo);
  // The launch mode is sticky: most people keep one posture.
  settings.update({ defaultPermissionMode: cmd.permissionMode ?? 'auto' });
  return { ok: true };
}

/**
 * Resumes or forks a stored conversation with the agent that wrote it.
 *
 * The agent is carried on the command rather than guessed: a Codex thread id
 * means nothing to Claude and vice versa, so resuming with the wrong driver
 * fails in a way that looks like corrupt history.
 */
export function resumeSavedSession(
  cmd: Extract<ClientCommand, { type: 'resume_saved_session' | 'fork_saved_session' }>,
  manager: SessionManager,
  settings: SettingsStore,
): void {
  const cwd = normalizePath(cmd.cwd);
  assertUsableDirectory(cwd);
  manager.launch({
    cwd,
    agent: cmd.agent ?? 'claude',
    permissionMode: cmd.permissionMode ?? settings.get().defaultPermissionMode,
    resume: cmd.sessionId,
    ...(cmd.type === 'fork_saved_session' ? { forkSession: true } : {}),
  });
  settings.rememberDirectory(cwd);
}
