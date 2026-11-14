import { memo, useState } from "react";
import type { Message, MessagePart } from "../state/store";
import { cutOffError } from "../state/chat";
import { isSubagentDetails, subagentSummary } from "../subagent";
import { Markdown } from "./Markdown";
import { SubagentCard } from "./SubagentCard";
import { AlertIcon, BrainIcon, CheckIcon, ChevronRightIcon, CopyIcon, InfoIcon, RefreshIcon, ToolIcon, XIcon } from "./Icons";

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

/** The one argument that says what a tool call did, such as a command or a file path. */
function toolSummary(args: Record<string, unknown> = {}) {
  const key = ["command", "path", "file_path", "pattern", "url", "query"].find((k) => typeof args[k] === "string");
  const text = key ? String(args[key]) : JSON.stringify(args);
  return text === "{}" ? "" : text.split("\n")[0];
}

/** A subagent call, with the child's live status in the header. */
function SubagentCall({ tool }: { tool: Extract<MessagePart, { type: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const details = isSubagentDetails(tool.details) ? tool.details : null;
  const state = !tool.done ? "is-running" : tool.isError ? "is-error" : "";
  const summary = details ? subagentSummary(details, !!tool.done) : toolSummary(tool.args);
  return (
    <div className={`tool-call is-subagent ${state} ${open ? "is-open" : ""}`}>
      <button className="tool-call-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ToolIcon size={14} />
        <span className="tool-call-name">subagent</span>
        <span className={`tool-call-summary ${tool.done ? "" : "shimmer"}`}>{summary}</span>
        {tool.isError && <AlertIcon size={14} />}
        <ChevronRightIcon size={14} className="reasoning-chevron" />
      </button>
      {open && <SubagentCard details={details} result={tool.result} isError={tool.isError} args={tool.args} done={!!tool.done} />}
    </div>
  );
}

/** A tool an agent harness ran. Subagent calls get a dedicated view. */
function ToolCall({ tool }: { tool: Extract<MessagePart, { type: "tool" }> }) {
  if (tool.name === "subagent") return <SubagentCall tool={tool} />;
  const [open, setOpen] = useState(false);
  const state = !tool.done ? "is-running" : tool.isError ? "is-error" : "";
  return (
    <div className={`tool-call ${state} ${open ? "is-open" : ""}`}>
      <button className="tool-call-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ToolIcon size={14} />
        <span className="tool-call-name">{tool.name}</span>
        <span className={`tool-call-summary ${tool.done ? "" : "shimmer"}`}>{toolSummary(tool.args)}</span>
        {tool.isError && <AlertIcon size={14} />}
        <ChevronRightIcon size={14} className="reasoning-chevron" />
      </button>
      {open && (
        <div className="tool-call-body">
          {tool.args && Object.keys(tool.args).length > 0 && <pre>{JSON.stringify(tool.args, null, 2)}</pre>}
          {tool.done ? <pre className="tool-call-result">{tool.result || "(no output)"}</pre> : <span className="shimmer">Running</span>}
        </div>
      )}
    </div>
  );
}

type ToolPart = Extract<MessagePart, { type: "tool" }>;

/** "bash ×3, read ×2, edit": which tools a run of calls used, most used first. */
function toolCounts(tools: ToolPart[]) {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

/** A run of tool calls between two pieces of text, folded into one card. */
function ToolGroup({ tools }: { tools: ToolPart[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.find((t) => !t.done);
  const failed = tools.some((t) => t.isError);
  const state = running ? "is-running" : failed ? "is-error" : "";
  return (
    <div className={`tool-call tool-group ${state} ${open ? "is-open" : ""}`}>
      <button className="tool-call-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ToolIcon size={14} />
        <span className="tool-call-name">{tools.length} tool calls</span>
        <span className={`tool-call-summary ${running ? "shimmer" : ""}`}>
          {running ? `${running.name} ${toolSummary(running.args)}` : toolCounts(tools)}
        </span>
        {failed && <AlertIcon size={14} />}
        <ChevronRightIcon size={14} className="reasoning-chevron" />
      </button>
      {open && (
        <div className="tool-group-list">
          {tools.map((t) => <ToolCall key={t.id} tool={t} />)}
        </div>
      )}
    </div>
  );
}

/** Message parts with each run of tool calls gathered up, so text and runs alternate. */
function groupParts(parts: MessagePart[]) {
  const out: ({ type: "text"; text: string; index: number } | { type: "tools"; tools: ToolPart[] })[] = [];
  parts.forEach((part, index) => {
    const last = out.at(-1);
    if (part.type === "text") out.push({ ...part, index });
    else if (last?.type === "tools") last.tools.push(part);
    else out.push({ type: "tools", tools: [part] });
  });
  return out;
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

  const waiting = message.streaming && !message.content && !message.reasoning && !message.parts;
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
      {message.parts
        ? groupParts(message.parts).map((group) =>
            group.type === "tools" ? (
              group.tools.length === 1 ? <ToolCall key={group.tools[0].id} tool={group.tools[0]} /> : <ToolGroup key={group.tools[0].id} tools={group.tools} />
            ) : (
              <div key={group.index} className={message.streaming && group.index === message.parts!.length - 1 ? "is-streaming" : ""}>
                <Markdown text={group.text} />
              </div>
            ),
          )
        : message.content && (
            <div className={message.streaming ? "is-streaming" : ""}>
              <Markdown text={message.content} />
            </div>
          )}
      {message.error && (
        <div className="error-card">
          <AlertIcon size={16} />
          <span className="error-text">{cutOffError(message)}</span>
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
