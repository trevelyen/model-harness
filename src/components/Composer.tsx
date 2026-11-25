import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDismiss } from "../lib/useDismiss";
import type { Effort, ReasoningSupport } from "../adapters/types";
import type { ReasoningChoice } from "../state/store";
import { ArrowUpIcon, BrainIcon, DiffIcon, SettingsIcon, StopIcon } from "./Icons";

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
  useDismiss(ref, open, () => setOpen(false));
  return { open, setOpen, ref };
}

/** The sheet that slides up from behind a composer. Hidden from the keyboard and screen readers while closed. */
export function ComposerSheet({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <div className={`composer-sheet ${open ? "is-open" : ""}`} aria-hidden={!open} inert={!open}>
      <div className="composer-sheet-inner">{children}</div>
    </div>
  );
}

/** The cog that opens a composer's sheet. */
export function SheetButton({ open, onClick, label, title }: { open: boolean; onClick: () => void; label: string; title?: string }) {
  return (
    <button type="button" className={`icon-button ${open ? "is-active" : ""}`} aria-label={label} aria-expanded={open} title={title} onClick={onClick}>
      <SettingsIcon size={16} />
    </button>
  );
}

/** A composer's text box. It grows with its text up to 240px, and Enter sends while Shift+Enter starts a new line. */
export function MessageBox({ value, onChange, onSubmit, autoFocus }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // On mount only, as the autoFocus attribute would.
  }, []);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder="Message"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

export function Composer({
  busy,
  onSend,
  onStop,
  hint,
  reasoning,
  context,
  changes,
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
  /** The button that shows and hides the changes pane. No button without it. */
  changes?: { open: boolean; onToggle: () => void };
  /** What the cog's sheet shows. No cog without it. */
  settings?: ReactNode;
}) {
  const [text, setText] = useState("");
  const sheet = useSheet();

  const submit = () => {
    const value = text.trim();
    if (!value || busy) return;
    onSend(value);
    setText("");
  };

  return (
    <div className="composer-wrap">
      <div className="composer-stack" ref={sheet.ref}>
        {settings && <ComposerSheet open={sheet.open}>{settings}</ComposerSheet>}
        <form className="composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <MessageBox value={text} onChange={setText} onSubmit={submit} autoFocus />
          <div className="composer-bar">
            <div className="composer-bar-start">
              {settings && (
                <SheetButton open={sheet.open} label="Chat type settings" title="Settings for this chat type" onClick={() => sheet.setOpen((o) => !o)} />
              )}
              {reasoning && <ReasoningControls {...reasoning} />}
            </div>
            <span />
            <div className="composer-bar-end">
              {context && <ContextRing {...context} />}
              {changes && (
                <button
                  type="button" className={`icon-button ${changes.open ? "is-active" : ""}`}
                  aria-label="Changes" aria-pressed={changes.open} title="Changes" onClick={changes.onToggle}
                >
                  <DiffIcon size={16} />
                </button>
              )}
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
