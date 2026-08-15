import { getSessionInfo, getSessionMessages, listSessions, renameSession, tagSession } from '@anthropic-ai/claude-agent-sdk';
import type { FileCheckpoint, SavedSession } from '@claudia/shared';

export async function savedSessions(cwd?: string): Promise<SavedSession[]> {
  const sessions = await listSessions(cwd ? { dir: cwd, limit: 40 } : { limit: 40 });
  return sessions.map(({ sessionId, summary, lastModified, cwd: sessionCwd, tag, customTitle }) => ({ sessionId, summary, lastModified, cwd: sessionCwd, tag, customTitle }));
}

export async function savedSessionDetail(sessionId: string, cwd?: string): Promise<FileCheckpoint[]> {
  if (!(await getSessionInfo(sessionId, cwd ? { dir: cwd } : undefined))) return [];
  return (await getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined))
    .filter((message) => message.type === 'user')
    .map((message) => ({ messageId: message.uuid, label: messageLabel(message.message) }));
}

export const retitleSavedSession = (id: string, title: string, cwd?: string) => renameSession(id, title, cwd ? { dir: cwd } : undefined);
export const retagSavedSession = (id: string, tag: string | null, cwd?: string) => tagSession(id, tag, cwd ? { dir: cwd } : undefined);

function messageLabel(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content;
  return (typeof content === 'string' ? content : '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'User message';
}
