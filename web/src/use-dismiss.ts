import { useEffect, useRef, type RefObject } from 'react';

/**
 * Closes a popover when the pointer goes down outside it, or on Escape.
 *
 * Every menu on the board was open until something else toggled it: the model
 * picker, the agent picker, the reasoning controls, the output styles and the
 * tile's overflow menu each tracked their own `open` and none of them watched
 * for a click that landed elsewhere. Two left open at once overlapped, and the
 * one underneath was unreachable without first finding the button that had
 * opened it.
 *
 * `pointerdown` rather than `click`, for two reasons. It fires before focus
 * moves, so a menu closes as the next control is being pressed rather than
 * after it has been activated; and the model picker's own items already use
 * `mousedown` with `preventDefault` to keep the composer focused, which a
 * `click`-based dismissal would race.
 *
 * Every node named as "inside" is exempt, and the TRIGGER has to be one of
 * them. Treating only the menu as inside closes it on the way down through the
 * trigger, whose own handler then immediately reopens it — so the button stops
 * working. Menus that live inside their trigger's wrapper get this for free
 * from `useDismiss`; a menu rendered through a portal is not a descendant of
 * anything, and has to be named separately (see `useAnchoredMenu`).
 */
export function useDismissRefs(
  open: boolean,
  close: () => void,
  insides: readonly RefObject<Node | null>[],
): void {
  // Held in refs so the effect below depends only on `open`. Both of these
  // arrive as a fresh identity every render — an inline arrow for `close`, an
  // array literal for `insides` — and depending on either would tear the
  // listeners down and re-add them on every keystroke.
  const latest = useRef(close);
  latest.current = close;
  const inside = useRef(insides);
  inside.current = insides;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // A node already detached by this render is not "outside": the menu item
      // that was just clicked can be gone before this runs, and treating that
      // as an outside click would close a menu the component is mid-way
      // through handling.
      if (!(target instanceof Node) || !target.isConnected) return;
      if (inside.current.some((node) => node.current?.contains(target))) return;
      latest.current();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latest.current();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
}

/**
 * The common case: one ref, on an element wrapping BOTH the trigger and the
 * menu. Used by the popovers that open inside their own tile rather than
 * against the viewport.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useDismissRefs(open, close, [ref]);
  return ref;
}
