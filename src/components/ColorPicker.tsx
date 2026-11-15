import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { trackPointer } from "../lib/drag";

type Hsv = { h: number; s: number; v: number };

const clamp = (n: number) => Math.max(0, Math.min(1, n));

function hexToHsv(hex: string): Hsv | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex({ h, s, v }: Hsv) {
  const f = (k: number) => {
    const x = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(x, 4 - x, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("");
}

/** Tracks a drag across an element, reporting where the pointer is as 0 to 1 on each axis. */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const report = (ev: { clientX: number; clientY: number }) => {
      const box = el.getBoundingClientRect();
      onMove(clamp((ev.clientX - box.left) / box.width), clamp((ev.clientY - box.top) / box.height));
    };
    report(e);
    trackPointer(e, report);
  };
  return { ref, onPointerDown };
}

/**
 * A saturation and brightness square, a hue strip and a hex field.
 * Keeps its own hue, so dragging to grey and back doesn't lose it.
 */
export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 250, s: 0.6, v: 0.94 });
  const [text, setText] = useState(value);

  // Follow the value when it changes from outside, like a preset being clicked.
  useEffect(() => {
    if (value.toLowerCase() === hsvToHex(hsv)) return;
    const next = hexToHsv(value);
    if (next) setHsv(next);
    setText(value);
    // Only an outside change to `value` matters here; the picker's own changes already match it.
  }, [value]);

  const update = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setText(hex);
    onChange(hex);
  };

  const area = useDrag((x, y) => update({ ...hsv, s: x, v: 1 - y }));
  const hue = useDrag((x) => update({ ...hsv, h: x * 360 }));
  const hex = hsvToHex(hsv);

  return (
    <div className="color-picker" style={{ "--hue": `hsl(${hsv.h} 100% 50%)`, "--picked": hex } as CSSProperties}>
      <div
        className="color-area"
        ref={area.ref}
        onPointerDown={area.onPointerDown}
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
        onKeyDown={(e) => {
          const dx = e.key === "ArrowRight" ? 0.02 : e.key === "ArrowLeft" ? -0.02 : 0;
          const dy = e.key === "ArrowUp" ? 0.02 : e.key === "ArrowDown" ? -0.02 : 0;
          if (!dx && !dy) return;
          e.preventDefault();
          update({ ...hsv, s: clamp(hsv.s + dx), v: clamp(hsv.v + dy) });
        }}
      >
        <span className="color-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div
        className="color-hue"
        ref={hue.ref}
        onPointerDown={hue.onPointerDown}
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        onKeyDown={(e) => {
          const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 4 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -4 : 0;
          if (!d) return;
          e.preventDefault();
          update({ ...hsv, h: (hsv.h + d + 360) % 360 });
        }}
      >
        <span className="color-thumb is-hue" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <div className="color-fields">
        <span className="color-preview" />
        <label className="color-hex">
          <span>#</span>
          <input
            value={text.replace(/^#/, "")}
            maxLength={6}
            spellCheck={false}
            aria-label="Hex colour"
            onChange={(e) => {
              const raw = e.target.value.replace(/[^0-9a-f]/gi, "");
              setText("#" + raw);
              const next = hexToHsv(raw);
              if (next) {
                setHsv(next);
                onChange("#" + raw.toLowerCase());
              }
            }}
            onBlur={() => setText(hex)}
          />
        </label>
      </div>
    </div>
  );
}
