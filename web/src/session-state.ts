import type { SessionSummary } from '@claudia/shared';

/**
 * The two shapes every session list-and-maps update takes.
 *
 * Extracted from `store.ts` rather than written inline there, and the reason is
 * the regression this file ships with: the store's event switch reached the
 * 400-line ceiling, a split was made under that pressure, and seven cases —
 * `session_upsert` and `session_removed` among them — were deleted instead of
 * moved. Keeping the bookkeeping out here means the switch stays a switch: one
 * short case per event, with nothing worth accidentally deleting inside it.
 */

/**
 * The session replaced where it already is, or appended if it is new.
 *
 * Replaced IN PLACE, never removed and re-added. The board sorts its own tiles,
 * but the array order is what several views fall back on, and a session that
 * jumped to the end of the list every time it changed state would reorder the
 * board on every keystroke of its own output.
 */
export function upsertSession(sessions: readonly SessionSummary[], session: SessionSummary): SessionSummary[] {
  const known = sessions.some((s) => s.id === session.id);
  return known ? sessions.map((s) => (s.id === session.id ? session : s)) : [...sessions, session];
}

/**
 * One key dropped from a map, without mutating the one that was passed in.
 *
 * Returns the original object when the key was not there, so a snapshot is not
 * replaced — and every subscriber not re-rendered — over a removal that
 * changed nothing.
 */
export function withoutKey<T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!Object.hasOwn(map, key)) return map as Record<string, T>;
  const next = { ...map };
  delete next[key];
  return next;
}
