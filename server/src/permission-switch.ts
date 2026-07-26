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
  getQuery: () => unknown | null;
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

  if (!ctx.getQuery()) {
    ctx.setMode(mode);
    ctx.feedInfo('Permission mode', describeMode(mode));
    ctx.updated();
    return 'in-place';
  }

  const q = ctx.getQuery() as { setPermissionMode?: (m: PermissionLaunchMode) => Promise<void> };
  if (q.setPermissionMode) {
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
  try {
    (ctx.getQuery() as { close?: () => void } | null)?.close?.();
  } catch {
    /* already closed */
  }

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
