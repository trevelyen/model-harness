/** Buttons in a pill, one of them chosen: a choice between options, or tabs. */
export function Segmented<T extends string | boolean>({ options, value, onChange, label, tabs, className }: {
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** Tabs switching a view, rather than a setting's options. */
  tabs?: boolean;
  className?: string;
}) {
  return (
    <div className={`segmented ${className ?? ""}`} role={tabs ? "tablist" : "radiogroup"} aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role={tabs ? "tab" : "radio"}
          aria-checked={tabs ? undefined : value === o.value}
          aria-selected={tabs ? value === o.value : undefined}
          className={value === o.value ? "is-active" : ""}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
