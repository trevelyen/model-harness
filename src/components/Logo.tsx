import { useId } from "react";

/**
 * The Model Harness mark: a curved strap beside a core. Graphite on a pearl tile.
 */
export function Logo({ size = 24 }: { size?: number }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-pearl`} x1="3" y1="1" x2="29" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#f4f2ee" />
          <stop offset="1" stopColor="#e3e0da" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0.15" stopColor="#f3dcec" stopOpacity="0" />
          <stop offset="0.4" stopColor="#f3dcec" stopOpacity="0.55" />
          <stop offset="0.6" stopColor="#dbe8f7" stopOpacity="0.55" />
          <stop offset="0.85" stopColor="#dbe8f7" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-graphite`} x1="8" y1="7" x2="24" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3a3c41" />
          <stop offset="1" stopColor="#1e1f22" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id}-pearl)`} />
      <rect width="32" height="32" rx="9" fill={`url(#${id}-sheen)`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="#000" strokeOpacity="0.08" />
      {/* Shifted right so the curve and dot together sit centred on the tile. */}
      <g transform="translate(3.3 0)">
        <g stroke={`url(#${id}-graphite)`} strokeLinecap="round" fill="none">
          <path d="M11.5 7.5C6 10.5 6 21.5 11.5 24.5" strokeWidth="2.8" />
        </g>
        <circle cx="16" cy="16" r="3.4" fill={`url(#${id}-graphite)`} />
      </g>
    </svg>
  );
}
