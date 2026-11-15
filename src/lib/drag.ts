import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Follows a drag that starts with `e`: `onMove` for each move until the pointer
 * is released, then `onEnd`. The element keeps the pointer, so the drag carries
 * on outside it.
 */
export function trackPointer(e: ReactPointerEvent<HTMLElement>, onMove: (ev: PointerEvent) => void, onEnd?: () => void) {
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const end = () => {
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", end);
    el.removeEventListener("pointercancel", end);
    onEnd?.();
  };
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}
