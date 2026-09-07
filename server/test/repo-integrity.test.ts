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

/**
 * Two things the board's menus need from this stylesheet, neither of which is
 * visible from the component that would break them.
 *
 * A tile header is 34px tall and hides what overflows it, so the agent picker
 * and the tile's overflow menu showed three pixels of themselves and the
 * terminal body through the rest until they were positioned against the
 * viewport. They now render into `document.body` as well, which puts `.tile`
 * out of reach — but `html` and `body` are still ancestors, and a `transform`,
 * `filter`, `contain` or `will-change` on either would establish a containing
 * block and trap the fixed menus inside it again.
 *
 * They also have to stay UNDER the app's overlays. Leaving the tile's subtree
 * means they compete with those directly instead of being buried beneath them,
 * and a menu on top of a modal is a menu the modal cannot dismiss.
 *
 * Asserted rather than remembered: nothing else in the suite would notice
 * either regression, and the web tests render no DOM to catch them in.
 */
describe('board stylesheet', () => {
  /**
   * Declaration-wise, not line-wise.
   *
   * The first version of this matched `^transform:` on trimmed LINES, and this
   * stylesheet writes a dozen rules as a single line with several declarations
   * on it — so `.tile { position: relative; transform: scale(1.02); }`, which
   * is exactly how somebody would add an animation, sailed straight past the
   * check written to catch it. Splitting on the delimiters first also keeps
   * `text-transform` out of it for free: the property either IS one of these
   * names or it is not.
   *
   * Inline styles in components are not covered. Every layout property in this
   * app lives in the stylesheet, and a scanner over JSX object literals would
   * trade a real guard for a fragile one.
   */
  const containingBlockProps = (css: string): string[] =>
    css
      .split(/[;{}\n]/)
      .map((part) => part.trim())
      .filter((part) => /^(transform|filter|backdrop-filter|contain|will-change|perspective)\s*:/.test(part));

  it('creates no containing block for the fixed-position menus', () => {
    const css = readFileSync(join(ROOT, 'web/src/app.css'), 'utf8');
    expect(containingBlockProps(css), 'these re-clip every board menu — see web/src/use-anchor.tsx').toEqual([]);
  });

  it('would notice one written inline, which is how it would be written', () => {
    // The guard's own regression test. Without it the check above passes
    // forever and proves nothing.
    expect(containingBlockProps('.tile { position: relative; transform: scale(1.02); overflow: hidden; }')).toEqual([
      'transform: scale(1.02)',
    ]);
    expect(containingBlockProps('.x { text-transform: uppercase; }')).toEqual([]);
  });

  /**
   * Read from both sides rather than pinned to a number here, so the two
   * cannot drift apart in silence. A menu that outranks an overlay floats on
   * top of it and stays there: dismissal watches for pointerdown and Escape,
   * and the palette and the usage drawer both open from the keyboard.
   */
  it('stacks the board menus below every overlay', () => {
    const source = readFileSync(join(ROOT, 'web/src/use-anchor.tsx'), 'utf8');
    const menuLayer = Number(/const MENU_LAYER = (\d+)/.exec(source)?.[1]);
    expect(menuLayer, 'MENU_LAYER is no longer a plain literal — this guard cannot read it').toBeGreaterThan(0);

    const overlays = [
      ...readFileSync(join(ROOT, 'web/src/app.css'), 'utf8').matchAll(/z-index:\s*(\d+)/g),
      ...readFileSync(join(ROOT, 'web/src/components/CommandPalette.tsx'), 'utf8').matchAll(/zIndex:\s*(\d+)/g),
    ].map((m) => Number(m[1]));
    expect(overlays.length).toBeGreaterThan(0);
    expect(Math.min(...overlays), `a menu at ${menuLayer} would cover an overlay`).toBeGreaterThan(menuLayer);
  });
});
