import type { ClientCommand, ServerEvent, WorktreeCleanupEntry } from '@claudia/shared';
import { previewCleanup, reapWorktrees, type ReapOutcome } from './worktree-reap.js';
import type { FleetStore } from '../store/index.js';

/**
 * The two cleanup commands, kept apart from `commands.ts` because they are the
 * only asynchronous ones.
 *
 * Every other mission command answers from the store and returns
 * `ServerEvent[]` synchronously. These read git — four invocations per record
 * — and making the whole router await for their sake would put an I/O boundary
 * in front of forty handlers that do not have one.
 */

const WORKTREE_COMMANDS = new Set(['preview_worktree_cleanup', 'remove_worktrees']);

export function isWorktreeCommand(cmd: ClientCommand): boolean {
  return WORKTREE_COMMANDS.has(cmd.type);
}

export async function handleWorktreeCommand(cmd: ClientCommand, store: FleetStore | undefined): Promise<ServerEvent[]> {
  if (!store) {
    return [{ type: 'fleet_unavailable', reason: 'the mission database is not open in this session' }];
  }
  switch (cmd.type) {
    case 'preview_worktree_cleanup': {
      const outcomes = await previewCleanup(store, cmd.missionId);
      return outcomes === undefined
        ? [unreadable(cmd.missionId)]
        : [{ type: 'worktree_cleanup', missionId: cmd.missionId, phase: 'preview', entries: outcomes.map(entryOf) }];
    }
    case 'remove_worktrees': {
      // An empty list is a client bug, not a request to remove everything.
      // Answering with the preview says what would have gone without going.
      if (cmd.worktreeIds.length === 0) {
        const outcomes = await previewCleanup(store, cmd.missionId);
        return outcomes === undefined
          ? [unreadable(cmd.missionId)]
          : [{ type: 'worktree_cleanup', missionId: cmd.missionId, phase: 'preview', entries: outcomes.map(entryOf) }];
      }
      const outcomes = await reapWorktrees(
        store,
        cmd.missionId,
        new Set(cmd.worktreeIds),
        cmd.confirmedUnmerged ? new Set(cmd.confirmedUnmerged) : undefined,
      );
      return outcomes === undefined
        ? [unreadable(cmd.missionId)]
        : [{ type: 'worktree_cleanup', missionId: cmd.missionId, phase: 'applied', entries: outcomes.map(entryOf) }];
    }
    default:
      return [];
  }
}

/**
 * A record and its verdict, flattened for the wire.
 *
 * `reason` is carried for the kept ones too. The plan asks for a preview, and
 * a preview that lists only what it will delete answers the wrong question —
 * the one a person actually has is "why is that one still here?".
 */
function entryOf(outcome: ReapOutcome): WorktreeCleanupEntry {
  return {
    worktreeId: outcome.record.id,
    path: outcome.record.path,
    branch: outcome.record.branch,
    state: outcome.record.state,
    removable: outcome.verdict.kind === 'remove',
    reason: outcome.verdict.reason,
    ...(outcome.removed === undefined ? {} : { removed: outcome.removed }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

/**
 * The store could not say which runs are alive.
 *
 * An empty plan would read as "nothing to clean up", which is the one answer
 * that is never safe to give from a failed read — `cleanupWorktree` requires
 * the busy set precisely so that not knowing and knowing-nothing stay
 * different answers.
 */
function unreadable(missionId: string): ServerEvent {
  return { type: 'fleet_unavailable', reason: `could not read what mission ${missionId} is using right now` };
}
