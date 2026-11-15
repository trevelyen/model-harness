import type { CSSProperties } from "react";

/**
 * The app's slider. A native range input, so the keyboard and screen readers
 * work as usual, drawn as a thin track filled with the accent up to the thumb.
 */
export function Range({ min, max, step, value, onChange, label, disabled }: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  /** For screen readers, when no visible label is tied to it. */
  label?: string;
  disabled?: boolean;
}) {
  const fill = max > min ? ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      style={{ "--fill": `${fill}%` } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}
