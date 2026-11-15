import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Effort, ReasoningSupport } from "../adapters/types";
import type { ReasoningChoice } from "../state/store";
import { ArrowUpIcon, BrainIcon, SettingsIcon, StopIcon } from "./Icons";

const EFFORTS: { value: Effort; label: string; budget: string; native: string }[] = [
  { value: "low", label: "Low", budget: "Thinks for up to about 1,000 tokens", native: "Brief thinking" },
  { value: "medium", label: "Medium", budget: "Thinks for up to about 4,000 tokens", native: "Moderate thinking" },
  { value: "high", label: "High", budget: "Thinks as long as it needs", native: "Thinks as long as it needs" },
];

function ReasoningControls({
  support,
  choice,
  onChange,
}: {
  support: ReasoningSupport;
  choice: ReasoningChoice;
  onChange: (next: ReasoningChoice) => void;
}) {
  const thinking = choice.thinking ?? support.defaultOn;
  return (
    <div className="reasoning-controls">
      <button
        type="button"
        className={`think-toggle ${thinking ? "is-on" : ""}`}
        aria-pressed={thinking}
        title={thinking ? "Thinking is on. Click to answer straight away." : "Thinking is off. Click to let the model think first."}
        onClick={() => onChange({ ...choice, thinking: !thinking })}
      >
        <BrainIcon size={15} />
        Think
      </button>
      <div className={`effort ${thinking ? "is-visible" : ""}`} role="radiogroup" aria-label="Thinking effort" aria-hidden={!thinking}>
        {EFFORTS.map((e) => (
          <button
            key={e.value}
            type="button"
            role="radio"
            tabIndex={thinking ? 0 : -1}
            aria-checked={choice.effort === e.value}
            className={choice.effort === e.value ? "is-active" : ""}
            title={support.effort === "native" ? e.native : e.budget}
            onClick={() => onChange({ ...choice, effort: e.value })}
          >
            {e.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The whole ring is what the model can handle. The lighter arc is the limit
 * the backend was started with, and the solid arc is what the chat has used.
 */
function ContextRing({ used, limit, max }: { used: number; limit: number; max: number }) {
  // Arcs are drawn as a share of 100, the circle's path length.
  const share = (tokens: number) => Math.min(1, tokens / max) * 100;
  const percent = Math.round(Math.min(1, used / limit) * 100);
  const title =
    `${used.toLocaleString()} of ${limit.toLocaleString()} tokens used (${percent}%).` +
    (max > limit ? ` The model can handle up to ${max.toLocaleString()}; raise Context size in the harness panel to use more.` : "");
  const arc = (length: number) => ({ strokeDasharray: `${length} ${100 - length}` });
  return (
    <span className={`context-ring ${used / limit >= 0.8 ? "is-full" : ""}`} title={title} role="meter" aria-label="Context used" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <span className="context-ring-percent">{percent}%</span>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle className="context-ring-track" cx="11" cy="11" r="8.5" pathLength={100} />
        {limit < max && <circle className="context-ring-limit" cx="11" cy="11" r="8.5" pathLength={100} style={arc(share(limit))} />}
        {/* At least a sliver, so a short chat still shows it has started. */}
        {used > 0 && <circle className="context-ring-used" cx="11" cy="11" r="8.5" pathLength={100} style={arc(Math.max(3, share(used)))} />}
      </svg>
    </span>
  );
}

/** The cog sheet's open state. A click outside `ref` or Escape closes it. */
export function useSheet() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return { open, setOpen, ref };
}

export function Composer({
  busy,
  onSend,
  onStop,
  hint,
  reasoning,
  context,
  settings,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hint?: string;
  /** Shown only when the selected model can think. */
  reasoning?: { support: ReasoningSupport; choice: ReasoningChoice; onChange: (next: ReasoningChoice) => void };
  /** Tokens the chat takes up, the backend's limit, and the most the model can handle. */
  context?: { used: number; limit: number; max: number };
  /** What the cog's sheet shows. No cog without it. */
  settings?: ReactNode;
}) {
  const [text, setText] = useState("");
  const { open: settingsOpen, setOpen: setSettingsOpen, ref: stackRef } = useSheet();
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => ref.current?.focus(), []);

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="composer-wrap">
      <div className="composer-stack" ref={stackRef}>
        {settings && (
          <div className={`composer-sheet ${settingsOpen ? "is-open" : ""}`} aria-hidden={!settingsOpen} inert={!settingsOpen}>
            <div className="composer-sheet-inner">{settings}</div>
          </div>
        )}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            placeholder="Message"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-bar-start">
              {settings && (
                <button
                  type="button"
                  className={`icon-button ${settingsOpen ? "is-active" : ""}`}
                  aria-label="Chat type settings"
                  aria-expanded={settingsOpen}
                  title="Settings for this chat type"
                  onClick={() => setSettingsOpen((o) => !o)}
                >
                  <SettingsIcon size={16} />
                </button>
              )}
              {reasoning && <ReasoningControls {...reasoning} />}
            </div>
            <span />
            <div className="composer-bar-end">
              {context && <ContextRing {...context} />}
              {busy ? (
                <button type="button" className="send is-stop" aria-label="Stop" onClick={onStop}>
                  <StopIcon size={20} />
                </button>
              ) : (
                <button type="submit" className="send" aria-label="Send" disabled={!text.trim()}>
                  <ArrowUpIcon size={18} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
      {hint && <p className="composer-hint">{hint}</p>}
    </div>
  );
}
