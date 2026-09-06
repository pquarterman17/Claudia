import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Evidence } from './acceptance.js';

/**
 * What the child says about its own work, in the one place it is asked for.
 *
 * `risks` and `artifacts` are the two evidence fields that are the CHILD's
 * account rather than an observation — the interface says so: risks are
 * "things the child itself flagged as unresolved", and they never block on
 * their own, because a child that admits a risk is behaving better than one
 * that does not. Nothing ever wrote them, so `describeGreen` could not mention
 * a risk and no reviewer ever saw one.
 *
 * A FILE in the worktree, rather than anything parsed out of a transcript: the
 * child is told about it in its brief, it is left behind where the evidence
 * gatherer already looks, and a child that ignores it produces an absence
 * rather than a misreading.
 *
 * Read as untrusted input, which is what it is. Everything is bounded — the
 * number of entries, the length of each — because this text ends up in the
 * event log, and a child that writes a megabyte of risks should cost a
 * truncation rather than a database nobody can read. Anything malformed is
 * dropped rather than repaired: half-understood self-reporting is worse than
 * none, since it reads on the board as though somebody had checked.
 */

/** Where the child is asked to leave it, relative to its worktree. */
export const REPORT_PATH = join('.claudia', 'report.json');

const MAX_ENTRIES = 20;
const MAX_LENGTH = 300;

export async function childReport(worktree: string): Promise<Pick<Evidence, 'risks' | 'artifacts'>> {
  let text: string;
  try {
    text = await readFile(join(worktree, REPORT_PATH), 'utf8');
  } catch {
    // No report is the common case and not a fault: the file is optional, and
    // a child that did not write one has said nothing rather than nothing good.
    return {};
  }
  if (text.length > 100_000) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const record = parsed as Record<string, unknown>;

  const risks = entries(record['risks']);
  const artifacts = entries(record['artifacts']);
  return {
    ...(risks.length > 0 ? { risks } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

/** A list of short strings, or nothing. Never a partially-understood one. */
function entries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
    .slice(0, MAX_ENTRIES)
    .map((entry) => (entry.length > MAX_LENGTH ? `${entry.slice(0, MAX_LENGTH)}…` : entry).trim());
}
