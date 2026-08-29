import type { ClientCommand } from '@claudia/shared';
import { assertUsableDirectory, normalizePath } from './folder-picker.js';
import type { SessionManager } from './session-manager.js';
import type { SettingsStore } from './settings-store.js';

/**
 * Resolves a launch/resume command into LaunchOptions and starts the session.
 *
 * Split out of gateway.ts's dispatch switch so the defaulting rules (agent,
 * permission mode, effort, thinking) live in one testable place — this is
 * also the one spot that decides which agent a new session runs, so launch
 * and resume cannot drift apart on it.
 */
export function launchSession(
  cmd: Extract<ClientCommand, { type: 'launch_session' }>,
  manager: SessionManager,
  settings: SettingsStore,
): void {
  const cwd = normalizePath(cmd.cwd);
  assertUsableDirectory(cwd);
  manager.launch({
    cwd,
    agent: cmd.agent ?? 'claude',
    prompt: cmd.prompt,
    model: cmd.model,
    permissionMode: cmd.permissionMode ?? 'auto',
    effortLevel: cmd.effortLevel ?? 'high',
    thinkingMode: cmd.thinkingMode ?? 'adaptive',
  });
  settings.rememberDirectory(cwd);
  // The launch mode is sticky: most people keep one posture.
  settings.update({ defaultPermissionMode: cmd.permissionMode ?? 'auto' });
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
