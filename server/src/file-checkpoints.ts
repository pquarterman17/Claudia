export interface RewindResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
}

export function rewindFiles(q: unknown, checkpointId: string): Promise<RewindResult> {
  const query = q as { rewindFiles?: (id: string) => Promise<RewindResult> } | null;
  return query?.rewindFiles
    ? query.rewindFiles(checkpointId)
    : Promise.resolve({ canRewind: false, error: 'This live session has not started yet.' });
}
