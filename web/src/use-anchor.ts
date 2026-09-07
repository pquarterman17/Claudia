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
 * A menu hung below `rect`, clamped to the viewport.
 *
 * `maxHeight` rather than a flip: a menu that opens upward near the bottom of
 * the screen and downward elsewhere moves under the cursor between one session
 * and the next, and these lists are short enough that scrolling the last one
 * or two into view is the smaller cost.
 */
export function belowAnchor(
  rect: Pick<DOMRect, 'bottom' | 'left' | 'right'>,
  align: 'left' | 'right' = 'left',
  /** Taken as an argument so this stays a pure function the tests can run;
   * the components never pass it. */
  viewport: { width: number; height: number } = { width: window.innerWidth, height: window.innerHeight },
): CSSProperties {
  const gap = 4;
  return {
    position: 'fixed',
    top: rect.bottom + gap,
    ...(align === 'left' ? { left: rect.left } : { right: Math.max(gap, viewport.width - rect.right) }),
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
