import { refuse } from './db.js';

/**
 * Turning SQLite rows back into domain objects.
 *
 * Every column comes back as `string | number | bigint | null | bytes`, so each
 * read has to insist on a shape. These helpers refuse rather than cast: a
 * column holding something other than what the schema declares means the file
 * was written by something that is not this code, and handing the UI a `string`
 * that is actually null is a worse outcome than one failed command.
 */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') refuse(`Column "${column}" is not text in the fleet database.`);
  return value;
}

export function optText(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') refuse(`Column "${column}" is not text in the fleet database.`);
  return value;
}

export function int(row: Row, column: string): number {
  const value = row[column];
  // bigint only appears for values outside the safe integer range, which none
  // of our columns (timestamps, counts, sequence numbers) will reach for
  // centuries; converting keeps the domain types plain numbers.
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') refuse(`Column "${column}" is not a number in the fleet database.`);
  return value;
}

export function optInt(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return int(row, column);
}

/** SQLite has no boolean type; the schema constrains these columns to 0 or 1. */
export function flag(row: Row, column: string): boolean {
  return int(row, column) === 1;
}

export function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/**
 * A JSON array of ids, as stored for Task.dependsOn.
 *
 * Refuses anything else instead of salvaging what it can. Dependencies decide
 * what may be dispatched, so a silently shortened list would let work start
 * early — a wrong answer is worse here than no answer.
 */
export function idList(row: Row, column: string): string[] {
  const raw = text(row, column);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    refuse(`Column "${column}" does not hold valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    refuse(`Column "${column}" is not a JSON array of ids.`);
  }
  return parsed as string[];
}
