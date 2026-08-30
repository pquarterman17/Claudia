import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Size ratchet — every TS/TSX/Rust source file in the repo stays under the
 * ceiling. Pins for legacy files only move DOWN; never raise the ceiling.
 * See claude-config rule size-ratchet-every-language.
 *
 * Rust ceiling: kept equal to the TS/TSX ceiling since there's no concrete
 * reason (verbosity, idiom) to diverge yet. If one shows up, give Rust its
 * own named constant instead of overloading this one.
 */
const CEILING = 400; // physical lines, tests excluded (see the Rust note below)
const PINS: Record<string, number> = {
  // repo starts clean — no legacy pins. Never add one; split the file instead.
};

const ROOT = join(import.meta.dirname, '..', '..');
// src-tauri/src is scanned for *.rs the same way the TS dirs are scanned for
// *.ts(x) — deliberately NOT src-tauri itself, so src-tauri/target/ (Cargo's
// build output, gitignored and potentially huge) is never walked.
const SCAN_DIRS = ['shared/src', 'server/src', 'web/src', 'src-tauri/src'];
const SOURCE_EXT = /\.(tsx?|rs)$/;
// TS/TSX test files (`*.test.ts(x)` / `*.spec.ts(x)`) live beside the code
// they test and are excluded here. Rust has no equivalent separate-file
// convention in this repo — unit tests live in an inline `#[cfg(test)] mod
// tests { ... }` block at the bottom of the file they test (see
// src-tauri/src/server.rs). Those lines are NOT excluded and count toward
// the file's total: this is deliberate, not an oversight, since an inline
// test module is still source text living inside that file's 400-line
// budget, same as any other block of code in it.
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
    else if (SOURCE_EXT.test(entry) && !EXCLUDE.test(entry)) out.push(full);
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
