import type { CostWindow } from '@claudia/shared';

/**
 * Parses the CLI's own `/cost` reply into structured plan-usage windows.
 *
 * This is the only source of REAL plan allowance Claudia has. There is no
 * documented HTTP API, SDK method, or CLI flag for it (see MAIN_PLAN's "Plan
 * limits" section) — but sending the literal text `/cost` as a prompt to a
 * live session returns the CLI's own accounting as an assistant text reply.
 * This module turns that text back into data.
 *
 * Kept pure and import-free (no SDK, no file I/O, no session handle) on
 * purpose: sending `/cost` for real costs tokens and pollutes a session's
 * transcript, so a unit test must never do that. Every case below is
 * exercised against a fixed string instead. Fetching the text is someone
 * else's job (see usage-service.ts's requestReal/captureReal).
 *
 * Deliberately permissive: an unrecognised line is skipped, not an error.
 * The CLI's phrasing is not a contract Claudia controls, and a parser that
 * throws on an unexpected line would take the whole usage panel down over a
 * copy change. Callers fall back to the local-history estimate whenever this
 * returns an empty array — including the "not on a subscription" case, where
 * `/cost` reports dollars instead of percentages and none of these lines appear.
 */

// "Current session: 20% used · resets Jul 26, 8:30pm (America/New_York)"
// "Current week (all models): 27% used · resets Jul 29, 10pm (America/New_York)"
// "Current week (Fable): 25% used · resets Jul 29, 10pm (America/New_York)"
// The separator is a middle dot (U+00B7), not a hyphen — matched literally.
const WINDOW_LINE = /^(Current session|Current week)(?:\s*\(([^)]+)\))?:\s*(\d{1,3})%\s*used\s*·\s*resets\s+(.+)$/;

export function parseCostReply(text: string): CostWindow[] {
  if (typeof text !== 'string') return [];
  const windows: CostWindow[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = WINDOW_LINE.exec(line);
    if (!match) continue;
    const [, scope, paren, pctText, resetsAt] = match;
    // The regex guarantees these three when it matches at all; the checks are
    // only here to satisfy noUncheckedIndexedAccess, not because they can fail.
    if (!scope || !pctText || !resetsAt) continue;
    const usedPct = clampPct(pctText);
    if (usedPct === null) continue;

    if (scope === 'Current session') {
      windows.push({ label: 'Current session', kind: 'session', usedPct, resetsAt });
    } else if (!paren) {
      windows.push({ label: 'Current week', kind: 'week', usedPct, resetsAt });
    } else if (paren.trim().toLowerCase() === 'all models') {
      // "(all models)" is the combined weekly window, not a per-model breakdown.
      windows.push({ label: `Current week (${paren})`, kind: 'week', usedPct, resetsAt });
    } else {
      windows.push({ label: `Current week (${paren})`, kind: 'week-model', model: paren, usedPct, resetsAt });
    }
  }

  return windows;
}

/** Integer 0–100, or null for anything a real `/cost` reply would never print. */
function clampPct(text: string): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}
