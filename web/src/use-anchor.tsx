import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useDismissRefs } from './use-dismiss';

/**
 * A menu hung off a control in a tile header.
 *
 * A tile header is 34px tall and clips what overflows it, because a long path
 * or title must not spill across the row. So a menu opening below it had three
 * of its pixels inside the header and the rest cut off, with the terminal body
 * showing through where the menu should have been. `z-index` cannot help: a
 * clipped box is clipped whatever it stacks above.
 *
 * Four things have to be true at once for that menu to work, and this hook
 * owns all four, because every time they were left to the call site one of
 * them was missed:
 *
 *  1. It is positioned against the VIEWPORT, from a rect re-read while open.
 *  2. It is rendered into `document.body`, so no ancestor can clip or stack
 *     it. `position: fixed` alone already escapes `overflow: hidden`, but only
 *     while nothing in between establishes a containing block for fixed
 *     elements — a `transform`, `filter`, `contain` or `will-change` anywhere
 *     up the tree silently re-clips it. The portal removes the ancestors
 *     rather than the properties, so there is nothing left to get wrong.
 *  3. Its own node counts as "inside" for dismissal. Once it is not a
 *     descendant of the trigger, an outside-click check that only knows about
 *     the trigger treats choosing an item as a click elsewhere and closes the
 *     menu before the item's handler runs.
 *  4. Focus moves into it. A portal puts the menu last in `document.body`, so
 *     tab order no longer runs from the trigger into the menu — without this a
 *     keyboard user opens it and then tabs through the whole application.
 *
 * `render` returns null until the trigger has been measured, so a caller
 * cannot paint a menu at the top-left corner for one frame.
 */
export interface AnchoredMenu<T extends HTMLElement> {
  /** Goes on the control the menu hangs from. */
  trigger: RefObject<T | null>;
  /** Spread onto that control, so the pair is described as one thing. */
  triggerProps: { 'aria-haspopup': 'menu'; 'aria-expanded': boolean };
  /** Wraps the menu's rows in the positioned, portaled, labelled box. */
  render: (children: ReactNode, style?: CSSProperties) => ReactNode;
}

export function useAnchoredMenu<T extends HTMLElement>(
  open: boolean,
  close: () => void,
  { label, align = 'left', width = 210 }: { label: string; align?: 'left' | 'right'; width?: number },
): AnchoredMenu<T> {
  const trigger = useRef<T | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const rect = useAnchorRect(trigger, open);
  useDismissRefs(open, close, [trigger, menu]);
  useMenuFocus(open && rect !== undefined, trigger, menu);

  return {
    trigger,
    triggerProps: { 'aria-haspopup': 'menu', 'aria-expanded': open },
    render: (children, style) =>
      open && rect
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              aria-label={label}
              style={{ ...belowAnchor(rect, align, width), zIndex: MENU_LAYER, minWidth: width, ...style }}
            >
              {children}
            </div>,
            document.body,
          )
        : null,
  };
}

/**
 * Above the board, below anything modal.
 *
 * Leaving the tile's subtree means these menus now compete with the app's
 * overlays directly instead of being buried under them: the usage drawer's
 * backdrop and the launch bar's panel sit at 20, the command palette at 40. A
 * menu that outranked those would float on top of a modal it has no way to
 * dismiss — dismissal watches for pointerdown and Escape, and both overlays
 * open from the keyboard, so nothing would ever close it.
 */
const MENU_LAYER = 15;

/**
 * Where the trigger is on screen, re-read for as long as the menu is open.
 *
 * Tiles scroll inside the board and the board reflows on resize, so a position
 * measured once would leave the menu behind the moment anything moved.
 */
function useAnchorRect<T extends HTMLElement>(ref: RefObject<T | null>, open: boolean): DOMRect | undefined {
  const [rect, setRect] = useState<DOMRect | undefined>(undefined);

  const measure = useCallback(() => {
    const next = ref.current?.getBoundingClientRect();
    // Bail out when the trigger has not actually moved. The scroll listener is
    // capture-phase over the whole document, so a session streaming output
    // scrolls its own feed and fires this on every frame — and a fresh DOMRect
    // is never `===` the last one, so without this the tile re-renders
    // continuously for as long as a menu is open next to a working session.
    setRect((prev) => (prev && next && sameSpot(prev, next) ? prev : next));
  }, [ref]);

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

  return rect;
}

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Moves focus into the menu when it opens, and hands it back when it closes. */
function useMenuFocus<T extends HTMLElement>(
  ready: boolean,
  trigger: RefObject<T | null>,
  menu: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!ready) return;
    // The menu is already inside the viewport by construction, so there is
    // nothing to scroll to and a scroll here would only jog the board.
    menu.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus({ preventScroll: true });
    return () => {
      // Only when closing orphaned the focus. A pointer that landed somewhere
      // else has already put focus where the user chose, and pulling it back
      // to the trigger would undo their click.
      if (document.activeElement === document.body) trigger.current?.focus({ preventScroll: true });
    };
  }, [ready, trigger, menu]);
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
  // opposite edge unbounded, which is the bug this function once had.
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
