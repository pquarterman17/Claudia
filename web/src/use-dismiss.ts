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
 * The ref goes on the element that wraps BOTH the trigger and the menu. A ref
 * on the menu alone closes it on the way down through the trigger and the
 * trigger's own handler immediately reopens it, so the button stops working.
 */
export function useDismiss<T extends HTMLElement>(open: boolean, close: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  // Held in a ref so the effect below depends only on `open`. An inline arrow
  // passed by a component re-renders into a new identity every render, which
  // would tear down and re-add the listeners on every keystroke.
  const latest = useRef(close);
  latest.current = close;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      // A node already detached by this render is not "outside": the menu item
      // that was just clicked can be gone before this runs, and treating that
      // as an outside click would close a menu the component is mid-way
      // through handling.
      if (!(target instanceof Node) || !target.isConnected) return;
      if (ref.current?.contains(target)) return;
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

  return ref;
}
