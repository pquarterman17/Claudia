import type { OutputStyles } from '@claudia/shared';

/**
 * The one SDK query method output styles need. The per-turn init message on
 * the message stream also carries the current style, but never the full
 * list — `available_output_styles` only ever comes from here, so both fields
 * are read from the same call rather than stitched from two sources.
 */
export interface OutputStyleQuery {
  initializationResult?: () => Promise<{ output_style?: string; available_output_styles?: string[] }>;
}

/**
 * Current style plus the full list this install offers, in one call.
 * Undefined on any failure — including an agent or SDK version with no such
 * method (Codex's query has neither) — so the caller leaves `outputStyles`
 * off the summary rather than show a picker with nothing in it.
 */
export async function fetchOutputStyles(q: OutputStyleQuery | null): Promise<OutputStyles | undefined> {
  if (!q?.initializationResult) return undefined;
  try {
    const result = await q.initializationResult();
    if (!result.output_style || !Array.isArray(result.available_output_styles)) return undefined;
    return { current: result.output_style, available: result.available_output_styles };
  } catch {
    return undefined;
  }
}
