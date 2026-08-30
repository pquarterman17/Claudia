/**
 * Catching a browser up without replaying the world at it.
 *
 * Claudia pushes state to every socket as it changes, which is fine when the
 * state is a dozen session tiles. A mission's event log is different: it is
 * append-only and grows for the life of the mission, so a tab that was asleep
 * for an hour cannot simply be handed everything. And the naive alternative —
 * always send the last N — silently drops events in exactly the case that
 * matters, a client that fell far behind.
 *
 * So the client says what it last saw and the server decides: a gap it can
 * close by replay, or one it cannot, in which case the honest answer is "start
 * again from a snapshot" rather than a timeline with a hole in it that nobody
 * will ever notice.
 */

export interface ResyncRequest {
  /** Highest sequence the client has rendered. 0 means it has nothing. */
  lastSeq: number;
}

export interface ResyncBounds {
  /** Lowest sequence still in the log; anything older has been pruned. */
  oldestSeq: number;
  /** Highest sequence the log holds. */
  newestSeq: number;
  /** Most events to send in one replay. */
  maxBatch: number;
}

export type ResyncPlan =
  | { kind: 'up_to_date' }
  | { kind: 'replay'; fromSeq: number; toSeq: number; more: boolean }
  | { kind: 'snapshot'; reason: string };

/**
 * How to get a client from `lastSeq` to the present.
 *
 * `snapshot` is not a failure path, it is the correct answer whenever a replay
 * would be a lie: the events are gone, or the client claims to have seen
 * something that does not exist. Sending a partial replay in either case
 * produces a UI that looks fine and is wrong, which is worse than a visible
 * reload.
 */
export function planResync(request: ResyncRequest, bounds: ResyncBounds): ResyncPlan {
  const { lastSeq } = request;
  const { oldestSeq, newestSeq, maxBatch } = bounds;

  // The server's own numbers first. Found in review: a maxBatch of zero or
  // less produced `toSeq = fromSeq - 1`, an empty-but-valid-looking range that
  // a caller would happily "replay" forever without advancing.
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) {
    return { kind: 'snapshot', reason: 'the replay batch size is not usable' };
  }
  if (!Number.isSafeInteger(oldestSeq) || !Number.isSafeInteger(newestSeq) || newestSeq < oldestSeq) {
    return { kind: 'snapshot', reason: 'the log bounds are not usable' };
  }
  if (!Number.isSafeInteger(lastSeq) || lastSeq < 0) {
    return { kind: 'snapshot', reason: 'the client sent a sequence that cannot exist' };
  }
  // Ahead of the log. Either the store was rebuilt underneath it or the client
  // is talking to a different server than it thinks.
  if (lastSeq > newestSeq) {
    return { kind: 'snapshot', reason: 'the client is ahead of the log' };
  }
  if (lastSeq === newestSeq) return { kind: 'up_to_date' };

  const from = lastSeq + 1;
  // The gap opens below what the log still holds: the missing events were
  // pruned and no replay can produce them.
  if (from < oldestSeq) {
    return { kind: 'snapshot', reason: `events before ${oldestSeq} are no longer kept` };
  }

  const to = Math.min(newestSeq, from + maxBatch - 1);
  return { kind: 'replay', fromSeq: from, toSeq: to, more: to < newestSeq };
}

/**
 * Whether a batch the store actually returned can be sent as a replay.
 *
 * Planning reads the bounds and fetching reads the events, and between those
 * two reads the log can be pruned or extended. Found in review: without this
 * the client is handed a batch with a hole in it and told it is contiguous,
 * which is the same silent gap the snapshot path exists to avoid. Cheap to
 * check, and the fallback is already built.
 */
export function replayIsUsable(seqs: readonly number[], fromSeq: number, toSeq: number): boolean {
  if (toSeq < fromSeq) return false;
  if (seqs.length !== toSeq - fromSeq + 1) return false;
  return seqs.every((seq, i) => seq === fromSeq + i);
}

/**
 * Collapses a burst of updates about the same thing into the last one.
 *
 * ONLY safe for complete replacement snapshots. Found in review: given
 * patches, dropping all but the last one drops the fields the earlier ones
 * carried, and the client ends up missing changes it was told it had. The
 * name says snapshots because the constraint is not enforceable in the type.
 *
 * A single mission pulse can touch a task, its run and its worktree several
 * times in a few milliseconds, and a browser that renders each one is doing
 * work nobody sees. Only the newest state of any given key is worth sending —
 * this is state replication, not an audit trail. The audit trail is the event
 * log, which is never coalesced.
 *
 * Order is preserved by the position of each key's LAST occurrence, so a
 * client applying the result in order ends up in the same place as one that
 * applied every update.
 */
export function coalesceSnapshots<T>(updates: readonly T[], keyOf: (update: T) => string): T[] {
  const lastIndex = new Map<string, number>();
  updates.forEach((update, index) => lastIndex.set(keyOf(update), index));
  const keep = new Set(lastIndex.values());
  return updates.filter((_, index) => keep.has(index));
}

/**
 * Whether a socket is too far behind to keep feeding.
 *
 * A slow consumer that is never dropped becomes unbounded memory in the
 * server, and the process that dies is the one running everybody's sessions.
 * Dropping it is safe precisely because resync exists: the client reconnects
 * and asks for a snapshot.
 */
export function isOverwhelmed(queuedBytes: number, limitBytes: number): boolean {
  return queuedBytes > limitBytes;
}
