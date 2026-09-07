import { describe, expect, it } from 'vitest';
import { belowAnchor } from '../src/use-anchor';

/**
 * Menus that hang below a tile header.
 *
 * The header is 34px tall and clips what overflows it — a long path must not
 * spill across the row — so a menu positioned against it showed three pixels
 * of itself and the terminal body through the rest. A body-level portal and
 * `position: fixed` escape that, and then the menu has to be kept inside the
 * viewport by hand, on all four sides. Three of them were easy to get right;
 * the fourth is why these tests exist.
 *
 * The portal, the dismissal and the focus move live in `useAnchoredMenu` and
 * need a DOM these tests do not have. This file covers the geometry, which is
 * pure; `server/test/repo-integrity.test.ts` covers the layering.
 */

const rect = (over: Partial<{ bottom: number; left: number; right: number }> = {}) => ({
  bottom: 100, left: 200, right: 260, ...over,
});
const viewport = { width: 1000, height: 800 };
const W = 210;

describe('belowAnchor', () => {
  it('hangs the menu under the trigger, left-aligned', () => {
    expect(belowAnchor(rect(), 'left', W, viewport)).toMatchObject({ position: 'fixed', top: 104, left: 200 });
  });

  it('aligns its right edge to the trigger when asked', () => {
    expect(belowAnchor(rect(), 'right', W, viewport)).toMatchObject({ left: 260 - W });
  });

  it('keeps a left-aligned menu on screen near the right edge', () => {
    // The bug this function shipped with: a right-hand tile put the trigger
    // 210px from the window edge and the menu ran off it, losing its last
    // column. Only reachable with more than one tile on the board.
    const style = belowAnchor(rect({ left: 960, right: 990 }), 'left', W, viewport);
    expect(Number(style.left) + W).toBeLessThanOrEqual(viewport.width);
  });

  it('keeps a right-aligned menu on screen near the left edge', () => {
    const style = belowAnchor(rect({ left: 10, right: 40 }), 'right', W, viewport);
    expect(Number(style.left)).toBeGreaterThanOrEqual(0);
  });

  it('bounds the far edge for a menu wider than its minimum', () => {
    // `left` is placed for the minimum width; content can exceed it, and
    // `maxWidth` is what stops that running off the same edge again.
    const style = belowAnchor(rect({ left: 960, right: 990 }), 'left', W, viewport);
    expect(Number(style.left) + Number(style.maxWidth)).toBeLessThanOrEqual(viewport.width);
  });

  it('caps the height at the room left below the trigger', () => {
    expect(belowAnchor(rect({ bottom: 600 }), 'left', W, viewport).maxHeight).toBe(800 - 600 - 12);
  });

  it('keeps a usable height for a trigger near the bottom edge', () => {
    // Without a floor this computes nothing and renders a menu with no rows,
    // which reads as broken rather than as out of room.
    expect(belowAnchor(rect({ bottom: 795 }), 'left', W, viewport).maxHeight).toBe(80);
  });
});
