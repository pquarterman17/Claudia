import type { EffortLevel, ThinkingMode } from '@claudia/shared';
import type { ParityQuery } from './parity-controls.js';
import type { RuntimeControlQuery, SessionRuntimeControls } from './session-runtime-controls.js';

/**
 * Changing one setting on a session that is already running.
 *
 * Model, effort, thinking and output style are four copies of one shape: ask
 * the live query to apply it, say so in the feed, refresh the tile. They lived
 * as four near-identical methods on ClaudiaSession, which is the one file in
 * the server that cannot afford to carry duplication.
 *
 * Applying is best-effort by design, and the failure is swallowed on purpose.
 * A session with no query yet has nothing to apply to, and an older CLI may not
 * expose the setter at all — in both cases the choice is still recorded locally
 * and carried into the next turn, which is exactly what the feed line promises
 * ("from the next turn"). Reporting an error here would be reporting one that
 * does not affect the outcome.
 */
export interface LiveSettingsCtx {
  /** The live SDK query, or null before the session has started one. */
  raw: unknown;
  controls: SessionRuntimeControls;
  announce: (title: string, meta: string) => void;
  updated: () => void;
}

async function change(
  ctx: LiveSettingsCtx,
  apply: () => Promise<unknown> | undefined,
  title: string,
  meta: string,
): Promise<void> {
  try {
    await apply();
  } catch {
    // See the note above: local state is the thing that matters here.
  }
  ctx.announce(title, meta);
  ctx.updated();
}

export function applyModel(ctx: LiveSettingsCtx, model: string): Promise<void> {
  const apply = () => (ctx.raw as ParityQuery | null)?.setModel?.(model);
  return change(ctx, apply, 'Model switched', `${model} — from the next turn`);
}

export function applyEffort(ctx: LiveSettingsCtx, effortLevel: EffortLevel): Promise<void> {
  const apply = () => ctx.controls.setEffort(ctx.raw as RuntimeControlQuery | null, effortLevel);
  return change(ctx, apply, 'Effort changed', effortLevel);
}

export function applyThinking(ctx: LiveSettingsCtx, thinkingMode: ThinkingMode): Promise<void> {
  const apply = () => ctx.controls.setThinking(ctx.raw as RuntimeControlQuery | null, thinkingMode);
  return change(ctx, apply, 'Thinking changed', thinkingMode);
}

export function applyOutputStyle(ctx: LiveSettingsCtx, style: string): Promise<void> {
  const apply = () => ctx.controls.setOutputStyle(ctx.raw as RuntimeControlQuery | null, style);
  return change(ctx, apply, 'Output style switched', `${style} — from the next turn`);
}
