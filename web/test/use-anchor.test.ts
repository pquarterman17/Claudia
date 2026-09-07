import { describe, expect, it } from 'vitest';
import { belowAnchor } from '../src/use-anchor';

/**
 * Menus that hang below a tile header.
 *
 * The header is 34px tall and clips what overflows it — a long path must not
 * spill across the row — so a menu positioned against it showed three pixels
 * of itself and the terminal body through the rest. `position: fixed` is what
 * escapes that, and it only escapes while nothing between the menu and the
 * viewport establishes a containing block for fixed elements.
 */

const rect = (over: Partial<{ bottom: number; left: number; right: number }> = {}) => ({
  bottom: 100, left: 200, right: 260, ...over,
});
const viewport = { width: 1000, height: 800 };

describe('belowAnchor', () => {
  it('hangs the menu under the trigger, left-aligned', () => {
    expect(belowAnchor(rect(), 'left', viewport)).toMatchObject({ position: 'fixed', top: 104, left: 200 });
  });

  it('aligns to the trigger’s right edge when asked', () => {
    // Measured from the right of the viewport, which is what `right` means.
    expect(belowAnchor(rect(), 'right', viewport)).toMatchObject({ right: 740 });
  });

  it('never positions the menu off the left of the screen', () => {
    const wide = belowAnchor(rect({ right: 1200 }), 'right', viewport);
    expect(wide.right).toBeGreaterThanOrEqual(4);
  });

  it('caps the height at the room left below the trigger', () => {
    expect(belowAnchor(rect({ bottom: 600 }), 'left', viewport).maxHeight).toBe(800 - 600 - 12);
  });

  it('keeps a usable height for a trigger near the bottom edge', () => {
    // Without a floor this computes nothing and renders a menu with no rows,
    // which reads as broken rather than as out of room.
    expect(belowAnchor(rect({ bottom: 795 }), 'left', viewport).maxHeight).toBe(80);
  });
});
