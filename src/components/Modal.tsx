import type { CSSProperties, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";

/**
 * A dialog over a dimmed page. Pressing the backdrop calls `onDismiss`. It's
 * rendered on <body>, so a parent's transform (the harness panel slides in) can't trap it.
 */
export function Modal({ className, label, labelledBy, alert, onDismiss, dialogRef, style, children }: {
  className?: string;
  label?: string;
  labelledBy?: string;
  /** A question that needs an answer, read out as soon as it opens. */
  alert?: boolean;
  onDismiss: () => void;
  dialogRef?: Ref<HTMLDivElement>;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onDismiss()}>
      <div
        className={`dialog ${className ?? ""}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-label={label}
        aria-labelledby={labelledBy}
        ref={dialogRef}
        style={style}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
