import type { SavedSession } from '@claudia/shared';
import { CodexClient } from './codex-client.js';
import { CodexNotInstalledError, spawnCodexAppServer, type CodexProcess } from './codex-process.js';

/**
 * Lists past Codex threads for a directory, for the resume picker.
 *
 * This spawns a short-lived app-server and closes it again. The alternative —
 * reading the rollout JSONL under `$CODEX_HOME/sessions/` directly — avoids the
 * spawn but couples Claudia to an on-disk format Codex does not promise to
 * keep. The picker is opened by hand and rarely, so a second of startup is the
 * cheaper cost.
 *
 * Never rejects, and never hangs. It is reached from a websocket handler,
 * where an unhandled rejection ends the process and an unanswered request
 * leaves the picker spinning with no way back. "No history to show" is a
 * perfectly good answer when Codex is absent, slow, or unhappy.
 */
export async function listCodexThreads(
  cwd: string,
  spawn: (cwd: string) => CodexProcess = spawnCodexAppServer,
): Promise<SavedSession[]> {
  let process_: CodexProcess | null = null;
  try {
    process_ = spawn(cwd);
  } catch (err) {
    // A missing Codex is not an error here: the user simply has no Codex
    // history, and the launch path already explains how to install it.
    if (err instanceof CodexNotInstalledError) return [];
    return [];
  }

  const client = new CodexClient(process_.channel, {
    onNotify: () => undefined,
    onApproval: async () => ({ kind: 'denied', rejection: 'Listing threads only' }),
    onClose: () => undefined,
  });

  try {
    const rows = await withTimeout(
      (async () => {
        await client.initialize();
        return client.listThreads(cwd);
      })(),
    );
    return rows.map(toSavedSession).filter((row): row is SavedSession => row !== null);
  } catch {
    return [];
  } finally {
    client.close();
  }
}

/** Maps a Codex thread row onto the picker's shape. */
function toSavedSession(row: Record<string, unknown>): SavedSession | null {
  const sessionId = typeof row['id'] === 'string' ? row['id'] : undefined;
  if (!sessionId) return null;
  const preview = typeof row['preview'] === 'string' ? row['preview'].trim() : '';
  const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
  // `recencyAt`/`updatedAt` are unix SECONDS here, unlike the millisecond
  // timestamps everything else in Claudia uses.
  const seconds = num(row['recencyAt']) || num(row['updatedAt']) || num(row['createdAt']);
  return {
    sessionId,
    summary: preview || name || 'Codex thread',
    lastModified: seconds > 0 ? seconds * 1000 : 0,
    agent: 'codex',
    ...(typeof row['cwd'] === 'string' ? { cwd: row['cwd'] } : {}),
    ...(name ? { customTitle: name } : {}),
  };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * How long to wait before giving up on a listing. Bounded deliberately: this
 * spawns a process, and a wedged app-server must not strand the picker.
 */
const LIST_TIMEOUT_MS = 15_000;

/** Rejects rather than hanging, so the caller can fall back to an empty list. */
function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Codex did not answer in time')), LIST_TIMEOUT_MS);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
