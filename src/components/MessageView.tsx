import { memo, useState } from "react";
import type { Message } from "../state/store";
import { Markdown } from "./Markdown";
import { AlertIcon, BrainIcon, CheckIcon, ChevronRightIcon, CopyIcon, InfoIcon, RefreshIcon, XIcon } from "./Icons";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="icon-button"
      aria-label="Copy"
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      })}
    >
      {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
    </button>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`reasoning ${open ? "is-open" : ""}`}>
      <button className="reasoning-toggle" onClick={() => setOpen((o) => !o)}>
        <BrainIcon size={15} />
        <span className={streaming ? "shimmer" : ""}>{streaming ? "Thinking" : "Thought process"}</span>
        <ChevronRightIcon size={14} className="reasoning-chevron" />
      </button>
      <div className="reasoning-body">
        <div className="reasoning-inner">{text}</div>
      </div>
    </div>
  );
}

interface Stat {
  text: string;
  title: string;
  warn?: boolean;
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const rate = (perSecond: number) => (perSecond >= 100 ? perSecond.toFixed(0) : perSecond.toFixed(1));

function stats(message: Message): Stat[] {
  const { usage = {}, startedAt, firstTokenAt, finishedAt } = message;
  if (!startedAt || !finishedAt) return [];
  const list: Stat[] = [];
  if (message.modelLabel) list.push({ text: message.modelLabel, title: "Model that wrote this reply" });
  if (usage.loadMs) list.push({ text: `Loaded in ${seconds(usage.loadMs)}`, title: "The model had to load before this reply" });
  if (usage.inputTokens) {
    let text = `${usage.inputTokens} in`;
    if (usage.promptRate) text += ` at ${rate(usage.promptRate)} tok/s`;
    const cached = usage.cachedTokens ? `, ${usage.cachedTokens} of them reused from cache` : "";
    list.push({ text, title: `Prompt tokens read${cached}` });
  }
  if (usage.outputTokens) {
    // Prefer the backend's own figure; otherwise time only the generating.
    const perSecond = usage.outputRate ?? usage.outputTokens / Math.max(0.001, (finishedAt - (firstTokenAt ?? startedAt)) / 1000);
    list.push({ text: `${usage.outputTokens} out at ${rate(perSecond)} tok/s`, title: "Tokens generated, including any thinking" });
  }
  if (firstTokenAt) list.push({ text: `First token ${seconds(firstTokenAt - startedAt)}`, title: "Wait before the first word, including any loading" });
  list.push({ text: `Total ${seconds(finishedAt - startedAt)}`, title: "Whole reply, from send to finish" });
  if (usage.finishReason === "length") list.push({ text: "Cut off", title: "Stopped at the max tokens limit", warn: true });
  return list;
}

export const MessageView = memo(function MessageView({
  message,
  isLast,
  onRegenerate,
  onDismissError,
}: {
  message: Message;
  isLast: boolean;
  onRegenerate: () => void;
  onDismissError: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  if (message.role === "user") {
    return (
      <div className="message is-user">
        <div className="bubble">{message.content}</div>
        <div className="message-actions">
          <CopyButton text={message.content} />
        </div>
      </div>
    );
  }

  const waiting = message.streaming && !message.content && !message.reasoning;
  const details = stats(message);
  return (
    <div className="message is-assistant">
      {message.reasoning && <Reasoning text={message.reasoning} streaming={!!message.streaming && !message.content} />}
      {waiting && (
        <div className="pending">
          <span className="dots"><i /><i /><i /></span>
          {message.status && <span className="shimmer">{message.status}</span>}
        </div>
      )}
      {message.content && (
        <div className={message.streaming ? "is-streaming" : ""}>
          <Markdown text={message.content} />
        </div>
      )}
      {message.error && (
        <div className="error-card">
          <AlertIcon size={16} />
          <span className="error-text">{message.error}</span>
          <button className="error-dismiss" aria-label="Dismiss error" onClick={onDismissError}>
            <XIcon size={15} />
          </button>
        </div>
      )}
      {!message.streaming && (
        <div className={`message-actions ${showDetails ? "is-pinned" : ""}`}>
          {message.content && <CopyButton text={message.content} />}
          {isLast && (
            <button className="icon-button" aria-label="Regenerate" onClick={onRegenerate}>
              <RefreshIcon size={15} />
            </button>
          )}
          {details.length > 0 && (
            <button
              className={`icon-button ${showDetails ? "is-active" : ""}`}
              aria-label="Reply details"
              aria-expanded={showDetails}
              onClick={() => setShowDetails((s) => !s)}
            >
              <InfoIcon size={15} />
            </button>
          )}
          {showDetails && details.length > 0 && (
            <span className="message-stats">
              {details.map((d) => (
                <span key={d.text} className={`stat ${d.warn ? "is-warn" : ""}`} title={d.title}>{d.text}</span>
              ))}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
