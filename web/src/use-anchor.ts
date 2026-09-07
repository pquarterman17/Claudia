import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/**
 * Where a popover's trigger is on screen, so the popover can be positioned
 * against the VIEWPORT rather than against its own ancestors.
 *
 * A tile header is 34px tall and clips what overflows it, because a long path
 * or title must not spill across the row. So a menu opening below the header —
 * the agent picker, the tile's overflow menu — had three of its pixels inside
 * the header and the rest cut off, with the terminal body showing through
 * where the menu should have been. `z-index` cannot help: a clipped box is
 * clipped whatever it stacks above.
 *
 * `position: fixed` escapes an `overflow: hidden` ancestor entirely, as long as
 * nothing between it and the viewport establishes a containing block for fixed
 * elements — no `transform`, `filter`, `contain` or `will-change`, which this
 * stylesheet has none of. `repo-integrity.test.ts` asserts that, because the
 * day someone adds a transform to `.tile` for an animation, every menu on the
 * board silently goes back to being clipped.
 *
 * The rect is re-read while the popover is open. Tiles scroll inside the board
 * and the board reflows on resize, so a position measured once would leave the
 * menu behind the moment anything moved.
 */
export function useAnchor<T extends HTMLElement>(open: boolean): { ref: RefObject<T | null>; rect: DOMRect | undefined } {
  const ref = useRef<T | null>(null);
  const [rect, setRect] = useState<DOMRect | undefined>(undefined);

  const measure = useCallback(() => {
    const next = ref.current?.getBoundingClientRect();
    // Bail out when the trigger has not actually moved. The scroll listener is
    // capture-phase over the whole document, so a session streaming output
    // scrolls its own feed and fires this on every frame — and a fresh DOMRect
    // is never `===` the last one, so without this the tile re-renders
    // continuously for as long as a menu is open next to a working session.
    setRect((prev) => (prev && next && sameSpot(prev, next) ? prev : next));
  }, []);

  // Layout effect so the first paint already has the position. A plain effect
  // renders the menu at the top-left corner for one frame before it jumps.
  useLayoutEffect(() => {
    if (!open) {
      setRect(undefined);
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    // Capture phase: the tile list scrolls in its own container, and a
    // listener on `window` alone never hears about that.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, measure]);

  return { ref, rect };
}

/**
 * A menu hung below `rect`, kept inside the viewport on all four sides.
 *
 * Horizontally as well as vertically, which the first version of this did not
 * do: a left-aligned menu on a right-hand tile started 210px from the window
 * edge and ran 49px off it, so the last of its rows was simply not there. That
 * only showed up with more than one tile on the board — the case a menu on a
 * FULL-WIDTH tile never reaches, and the one this was first checked against.
 *
 * `width` is the menu's own minimum, passed in because the style has to be
 * computed before there is anything to measure. `maxWidth` then closes the gap
 * for a menu whose content makes it wider than its minimum: the left edge is
 * placed for `width`, and the right edge is bounded whatever it turns out to
 * be.
 *
 * `maxHeight` rather than flipping upward near the bottom: a menu that opens
 * up in some places and down in others moves under the cursor between one
 * session and the next, and these lists are short enough that scrolling the
 * last row into view is the smaller cost.
 */
export function belowAnchor(
  rect: Pick<DOMRect, 'bottom' | 'left' | 'right'>,
  align: 'left' | 'right' = 'left',
  width = 210,
  /** Taken as an argument so this stays a pure function the tests can run;
   * the components never pass it. */
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): CSSProperties {
  const gap = 4;
  // Both alignments resolve to a left edge and are then clamped the same way.
  // Expressing "right-aligned" as a `right` property instead would leave the
  // opposite edge unbounded, which is the bug this function just had.
  const preferred = align === 'left' ? rect.left : rect.right - width;
  const left = Math.max(gap, Math.min(preferred, viewport.width - width - gap));
  return {
    position: 'fixed',
    top: rect.bottom + gap,
    left,
    maxWidth: Math.max(width, viewport.width - left - gap),
    // A floor as well as a ceiling: a trigger near the bottom of the window
    // would otherwise compute a maxHeight of nothing and render a menu with no
    // rows in it, which reads as broken rather than as out of room.
    maxHeight: Math.max(MIN_MENU_HEIGHT, viewport.height - rect.bottom - gap * 3),
    overflowY: 'auto',
  };
}

/** Enough for two rows and the hint under them. */
const MIN_MENU_HEIGHT = 80;

/** Only the corner the menu is hung from matters; size changes do not move it. */
function sameSpot(a: DOMRect, b: DOMRect): boolean {
  return a.bottom === b.bottom && a.left === b.left && a.right === b.right;
}
