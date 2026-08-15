export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

/**
 * Restores tracked files to a checkpoint. Reports failure as a value rather
 * than rejecting: the caller is a websocket handler, and an unhandled
 * rejection there ends the server process.
 */
export function rewindFiles(q: unknown, checkpointId: string): Promise<RewindResult> {
  const query = q as { rewindFiles?: (id: string) => Promise<RewindResult> } | null;
  if (!query?.rewindFiles) {
    return Promise.resolve({ canRewind: false, error: 'This live session has not started yet.' });
  }
  return query.rewindFiles(checkpointId).catch((err: unknown) => ({
    canRewind: false,
    error: err instanceof Error ? err.message : 'The checkpoint could not be restored.',
  }));
}
