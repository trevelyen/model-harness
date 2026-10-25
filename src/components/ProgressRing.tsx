/** A small circular progress indicator. Spins when the total is unknown. */
export function ProgressRing({ value, size = 20, paused = false }: { value?: number; size?: number; paused?: boolean }) {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const known = value !== undefined;
  return (
    <svg
      className={`ring ${known ? "" : "is-indeterminate"} ${paused ? "is-paused" : ""}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="progressbar"
      aria-valuenow={known ? Math.round(value * 100) : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
      <circle
        className="ring-value"
        cx={size / 2}
        cy={size / 2}
        r={r}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={known ? c * (1 - Math.min(1, value)) : c * 0.7}
      />
    </svg>
  );
}
