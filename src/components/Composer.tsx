import { useEffect, useRef, useState } from "react";
import type { Effort, ReasoningSupport } from "../adapters/types";
import type { ReasoningChoice } from "../state/store";
import { ArrowUpIcon, BrainIcon, StopIcon } from "./Icons";

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

export function Composer({
  busy,
  onSend,
  onStop,
  hint,
  reasoning,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  hint?: string;
  /** Shown only when the selected model can think. */
  reasoning?: { support: ReasoningSupport; choice: ReasoningChoice; onChange: (next: ReasoningChoice) => void };
}) {
  const [text, setText] = useState("");
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
          {reasoning && <ReasoningControls {...reasoning} />}
          <div className="composer-bar-spacer" />
          {busy ? (
            <button type="button" className="send is-stop" aria-label="Stop" onClick={onStop}>
              <StopIcon size={16} />
            </button>
          ) : (
            <button type="submit" className="send" aria-label="Send" disabled={!text.trim()}>
              <ArrowUpIcon size={18} />
            </button>
          )}
        </div>
      </form>
      {hint && <p className="composer-hint">{hint}</p>}
    </div>
  );
}
