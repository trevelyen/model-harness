import { useEffect, type RefObject } from "react";

/** While `open`, a click outside `ref` or the Escape key calls `close`. For menus and sheets. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const escape = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
    // Only `open` matters: the callers' `close` just sets their open state to false.
  }, [open]);
}
