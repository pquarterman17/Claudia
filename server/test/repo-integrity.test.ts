import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Size ratchet — every TS/TSX source file in the repo stays under the ceiling.
 * Pins for legacy files only move DOWN; never raise the ceiling. See
 * claude-config rule size-ratchet-every-language.
 */
const CEILING = 400; // physical lines, tests excluded
const PINS: Record<string, number> = {
  // repo starts clean — no legacy pins. Never add one; split the file instead.
};

const ROOT = join(import.meta.dirname, '..', '..');
const SCAN_DIRS = ['shared/src', 'server/src', 'web/src'];
const EXCLUDE = /\.(test|spec)\.tsx?$/;

function collect(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // workspace not created yet
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(entry) && !EXCLUDE.test(entry)) out.push(full);
  }
}

describe('size ratchet', () => {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) collect(join(ROOT, dir), files);

  it('finds source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(ROOT, f).replaceAll('\\', '/'), f]))(
    '%s stays under its ceiling',
    (rel, full) => {
      const lines = readFileSync(full, 'utf8').split('\n').length;
      const limit = PINS[rel] ?? CEILING;
      expect(lines, `${rel} is ${lines} lines (limit ${limit}) — split it, don't grow it`).toBeLessThanOrEqual(limit);
      if (PINS[rel] && lines <= CEILING) {
        throw new Error(`${rel} shrank under the general ceiling — delete its pin (graduation)`);
      }
    },
  );
});
