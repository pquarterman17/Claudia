import { getSessionInfo, getSessionMessages, listSessions, renameSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import type { FileCheckpoint, SavedSession } from '@claudia/shared';
import { listCodexThreads } from './codex-threads.js';

/**
 * Every one of these reads session files written by another process. A corrupt
 * or half-written file, a deleted session id, or a permissions error must
 * degrade to "nothing to show" — an unhandled rejection from any of them takes
 * the whole server process down on modern Node.
 */
export async function savedSessions(cwd?: string): Promise<SavedSession[]> {
  const sessions = await listSessions(cwd ? { dir: cwd, limit: 40 } : { limit: 40 }).catch(() => []);
  return sessions.map(({ sessionId, summary, lastModified, cwd: sessionCwd, tag, customTitle }) => ({ sessionId, summary, lastModified, cwd: sessionCwd, tag, customTitle }));
}

/**
 * Both agents' history for a directory, newest first.
 *
 * Merged here rather than in the gateway so the picker sees one list. Each row
 * carries the agent that wrote it, because resuming a Codex thread id with the
 * Claude driver (or the reverse) fails in a way that reads like corrupt
 * history rather than a mismatch.
 */
export async function allSavedSessions(cwd?: string): Promise<SavedSession[]> {
  const [claude, codex] = await Promise.all([
    savedSessions(cwd).then((rows) => rows.map((row) => ({ ...row, agent: 'claude' as const }))),
    cwd ? listCodexThreads(cwd) : Promise.resolve([]),
  ]);
  return [...claude, ...codex].sort((a, b) => b.lastModified - a.lastModified);
}

export async function savedSessionDetail(sessionId: string, cwd?: string): Promise<FileCheckpoint[]> {
  try {
    if (!(await getSessionInfo(sessionId, cwd ? { dir: cwd } : undefined))) return [];
    return (await getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined))
      .filter((message) => message.type === 'user' && isTypedPrompt(message.message))
      .map((message) => ({ messageId: message.uuid, label: messageLabel(message.message) }));
  } catch {
    return [];
  }
}

/** Both return false when the rename/tag could not be applied. */
export const retitleSavedSession = (id: string, title: string, cwd?: string): Promise<boolean> =>
  renameSession(id, title, cwd ? { dir: cwd } : undefined).then(() => true, () => false);
export const retagSavedSession = (id: string, tag: string | null, cwd?: string): Promise<boolean> =>
  tagSession(id, tag, cwd ? { dir: cwd } : undefined).then(() => true, () => false);

/**
 * Whether a transcript entry is something the user actually typed.
 *
 * `type: 'user'` covers far more than typed prompts — every tool result is fed
 * back to the model as a user turn, and they dominate any agentic session.
 * Measured on real transcripts here: 1310 of 1370 user-type entries were tool
 * results. Without this filter the checkpoint picker is a wall of near-identical
 * rows, and the handful of real prompts are impossible to find in it.
 * `message-router.ts` already draws the same distinction for the live feed.
 */
function isTypedPrompt(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  return !content.some((block) => (block as { type?: string } | null)?.type === 'tool_result');
}

/**
 * The prompt text for a checkpoint row.
 *
 * `content` is a bare string only sometimes; a prompt carrying images — or
 * simply written by a newer CLI — arrives as an array of blocks. Reading only
 * the string form collapsed most real prompts to the generic fallback, which
 * defeats the point of labelling checkpoints at all.
 */
function messageLabel(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => (block as { type?: string } | null)?.type === 'text')
            .map((block) => (block as { text?: string }).text ?? '')
            .join(' ')
        : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 100) || 'User message';
}
