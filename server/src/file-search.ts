import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FileMatch } from '@claudia/shared';

/**
 * Bounds for the walk. This is reached on every keystroke of an @-mention, so
 * it must return fast — and never eventually — against a tree the size of
 * this very repo's `node_modules`, not just a tidy example project.
 */
const MAX_RESULTS = 20;
const MAX_DEPTH = 10;
const BUDGET_MS = 200;
/** Bounds how many candidates get collected before ranking, so a query that
 * matches almost everything (a single common letter) can't make the walk or
 * the sort that follows it unbounded either. */
const CANDIDATE_CAP = 500;

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/** Never descend into VCS metadata, build output, or dependency trees — or
 * any dot-directory, the same convention editors and tools already use for
 * "not source". */
function shouldSkipDir(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name);
}

/**
 * Depth-first walk collecting paths (relative to `root`) whose lowercase form
 * contains `needle`. Stops the instant the candidate cap or deadline is hit,
 * so a huge or adversarial tree returns fast rather than eventually. A
 * directory that can't be read (permissions, a race with a delete) is
 * skipped, not fatal — this must never throw.
 */
function collect(root: string, dir: string, depth: number, needle: string, deadline: number, out: string[]): void {
  if (out.length >= CANDIDATE_CAP || Date.now() > deadline) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= CANDIDATE_CAP || Date.now() > deadline) return;
    if (entry.isDirectory()) {
      if (depth >= MAX_DEPTH || shouldSkipDir(entry.name)) continue;
      collect(root, join(dir, entry.name), depth + 1, needle, deadline, out);
    } else if (entry.isFile()) {
      const rel = relative(root, join(dir, entry.name)).split(sep).join('/');
      if (rel.toLowerCase().includes(needle)) out.push(rel);
    }
  }
}

/**
 * Ranks candidate paths for a query: a filename starting with it beats one
 * merely containing it, which beats a match found only elsewhere in the
 * path. Stable within each rank so the walk's own order carries through —
 * mirrors web/src/palette.ts's filterActions. Pure and filesystem-free so it
 * can be tested on its own.
 */
export function rankFileMatches(paths: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...paths];
  const ranked: Array<{ path: string; rank: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    let rank: number | null = null;
    if (name.startsWith(q)) rank = 0;
    else if (name.includes(q)) rank = 1;
    else if (lower.includes(q)) rank = 2;
    if (rank !== null) ranked.push({ path, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.path);
}

/**
 * Finds files under `cwd` for @-mention completion in the composer.
 *
 * Never rejects and never hangs: this is reached from a websocket handler,
 * where an unhandled rejection ends the process and an unanswered request
 * leaves the composer's dropdown spinning forever. An empty result is a
 * perfectly good answer for a bad path, a huge tree, or an unreadable
 * directory — none of those are the caller's problem to handle specially.
 */
export async function searchFiles(cwd: string, query: string): Promise<FileMatch[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  try {
    const candidates: string[] = [];
    collect(cwd, cwd, 0, needle, Date.now() + BUDGET_MS, candidates);
    return rankFileMatches(candidates, query)
      .slice(0, MAX_RESULTS)
      .map((path) => ({ path }));
  } catch {
    return [];
  }
}
