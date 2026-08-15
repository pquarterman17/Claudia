import type { RewindResult } from './file-checkpoints.js';

/**
 * The decision half of a file restore, kept out of the gateway so the rules are
 * readable and testable without a socket.
 *
 * Restoring files is the most destructive thing Claudia can do to a working
 * tree — it overwrites uncommitted work — so the refusal is re-checked on the
 * server. The client's confirm dialog is a courtesy, not a trust boundary.
 */
export type RewindDecision =
  | { ok: false; message: string }
  | { ok: true };

/** Refuses while a turn is in flight: Claude may be writing the same paths. */
export function decideRewind(busy: boolean): RewindDecision {
  return busy
    ? { ok: false, message: 'This session is still working. Interrupt it before restoring files.' }
    : { ok: true };
}

/** What to say once a restore has run. Silence left users guessing. */
export function describeRewind(result: RewindResult): { failed: boolean; message: string } {
  if (!result.canRewind) {
    return { failed: true, message: result.error ?? 'Files cannot be rewound to that checkpoint.' };
  }
  const files = result.filesChanged ?? [];
  if (files.length === 0) return { failed: false, message: 'no files changed' };
  const shown = files.slice(0, 3).join(', ');
  const more = files.length > 3 ? `, +${files.length - 3} more` : '';
  return { failed: false, message: `${files.length} file${files.length === 1 ? '' : 's'}: ${shown}${more}` };
}
