import { getSessionInfo, getSessionMessages, listSessions, renameSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import type { FileCheckpoint, SavedSession } from '@claudia/shared';

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

export async function savedSessionDetail(sessionId: string, cwd?: string): Promise<FileCheckpoint[]> {
  try {
    if (!(await getSessionInfo(sessionId, cwd ? { dir: cwd } : undefined))) return [];
    return (await getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined))
      .filter((message) => message.type === 'user')
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

function messageLabel(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  return (typeof content === 'string' ? content : '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'User message';
}
