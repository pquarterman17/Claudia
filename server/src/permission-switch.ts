import type { PermissionLaunchMode } from '@claudia/shared';
import { AsyncQueue } from './async-queue.js';
import { infoStep } from './feed.js';
import { describeMode } from './permission-labels.js';

/**
 * The mutable slice of a session that switching permission modes touches.
 * Accessors rather than raw fields, because the switch replaces the query and
 * the input queue and bumps the generation — state the session owns.
 */
export interface SwitchCtx {
  getMode: () => PermissionLaunchMode;
  setMode: (mode: PermissionLaunchMode) => void;
  /**
   * Whether a driver exists at all — the lifecycle question.
   *
   * Deliberately not `getQuery()`, which asks a CAPABILITY question: does this
   * driver expose an SDK query object to poke at. The two were conflated, and
   * once `CodexDriver` grew a `raw` of its own for the model picker the
   * conflation started answering "this session has not started yet" about
   * sessions that were running — see `applyAgentSwitch`.
   */
  hasStarted: () => boolean;
  getQuery: () => unknown | null;
  /** Shuts the outgoing driver down. A replaced driver keeps its child process. */
  closeDriver: () => void;
  replaceQuery: (mode: PermissionLaunchMode, resume: string | undefined, input: AsyncQueue<unknown>) => void;
  getInput: () => AsyncQueue<unknown>;
  setInput: (queue: AsyncQueue<unknown>) => void;
  bumpGeneration: () => void;
  resumeId: () => string | undefined;
  abandonForRestart: () => void;
  feedInfo: (title: string, meta?: string) => void;
  updated: () => void;
}

/**
 * Change permissions on a session.
 *
 * Tightening applies in place. Loosening cannot: the SDK refuses with "the
 * session was not launched with --dangerously-skip-permissions" — the same
 * restriction `claude` has in a terminal — so the session is relaunched with
 * `resume`, preserving the conversation. An empty session (no query yet) just
 * records the mode for its eventual first prompt.
 */
export async function switchPermissionMode(
  ctx: SwitchCtx,
  mode: PermissionLaunchMode,
): Promise<'in-place' | 'relaunched' | 'unchanged'> {
  if (ctx.getMode() === mode) return 'unchanged';

  // The lifecycle question, not the capability one. A session with no driver
  // has nothing to relaunch and nothing running under the old mode, so the
  // mode is simply recorded for its first prompt. Asking `getQuery()` here
  // conflated that with "this driver exposes no SDK object", which is true of
  // a Codex driver whose app-server never came up — and recording a mode
  // against a live session applies nothing while telling the user it did.
  if (!ctx.hasStarted()) {
    ctx.setMode(mode);
    ctx.feedInfo('Permission mode', describeMode(mode));
    ctx.updated();
    return 'in-place';
  }

  // Null-safe, now that reaching here no longer implies a query exists.
  const q = ctx.getQuery() as { setPermissionMode?: (m: PermissionLaunchMode) => Promise<void> } | null;
  if (q?.setPermissionMode) {
    try {
      await q.setPermissionMode(mode);
      ctx.setMode(mode);
      ctx.feedInfo('Permission mode', describeMode(mode));
      ctx.updated();
      return 'in-place';
    } catch {
      // Expected when loosening; fall through to a resuming relaunch.
    }
  }

  relaunch(ctx, mode);
  return 'relaunched';
}

/** Tears down the current query and resumes the same conversation under `mode`. */
function relaunch(ctx: SwitchCtx, mode: PermissionLaunchMode): void {
  const resumeId = ctx.resumeId();
  // Abandons the gate, clears any half-streamed draft, fails running steps,
  // and bumps the generation so the old consume loop becomes inert.
  ctx.abandonForRestart();
  // The DRIVER, not whatever `getQuery()` happens to expose. This used to
  // reach for a `close` on the raw query, which is the SDK object for Claude
  // and has one — but Codex's `raw` is a small facade carrying `supportedModels`
  // and `setModel` for the picker, and has none. So every loosening of
  // permissions on a live Codex session left its app-server child running for
  // the life of the board while a replacement was spawned beside it.
  ctx.closeDriver();

  // The old query's iterator still holds a pending read on the old queue; a
  // shared queue would race two consumers for the next prompt. Anything
  // buffered but never consumed carries over.
  const old = ctx.getInput();
  const unsent = old.drain();
  old.close();
  const fresh = new AsyncQueue<unknown>();
  for (const item of unsent) fresh.push(item);
  ctx.setInput(fresh);
  ctx.setMode(mode);

  ctx.feedInfo(
    'Restarted with new permissions',
    `${describeMode(mode)}${resumeId ? ' · conversation kept' : ''}`,
  );
  ctx.replaceQuery(mode, resumeId, fresh);
  ctx.updated();
}

export { infoStep };
