/** The app's on/off control. Put it inside a <label> and clicking the label's text flips it too. */
export function Switch({ on, onChange, label, title, small, disabled }: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** For screen readers, when no visible label wraps it. */
  label?: string;
  title?: string;
  small?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={`switch ${small ? "is-small" : ""} ${on ? "is-on" : ""}`}
      onClick={() => onChange(!on)}
    />
  );
}
