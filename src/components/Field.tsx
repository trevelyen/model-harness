import type { ReactNode } from "react";

/**
 * A setting with its label on top: the control below, an optional hint under it.
 * `value` shows at the label's right, as a slider's reading does; `control`
 * sits there instead, for a switch.
 */
export function Field({ label, value, control, hint, children }: {
  label: ReactNode;
  value?: ReactNode;
  control?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="field">
      <label>
        {label}
        {value !== undefined && <> <span className="value">{value}</span></>}
        {control}
      </label>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  );
}
