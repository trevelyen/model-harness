import { useState } from "react";
import { usageText, type SubagentDetails, type SubagentResult, type SubagentStatus } from "../subagent";
import { Markdown } from "./Markdown";
import { AlertIcon, CheckIcon, ChevronRightIcon } from "./Icons";

const statusClass: Record<SubagentStatus, string> = {
  pending: "is-pending",
  running: "is-running",
  completed: "is-done",
  failed: "is-failed",
  aborted: "is-failed",
};

function StatusIcon({ status }: { status: SubagentStatus }) {
  if (status === "completed") return <CheckIcon size={13} className="sub-status is-ok" />;
  if (status === "failed" || status === "aborted") return <AlertIcon size={13} className="sub-status is-bad" />;
  if (status === "running") return <span className="sub-status is-busy" />;
  return <span className="sub-status is-idle" />;
}

/** The child's tool calls, one line each, as it worked. */
function Trace({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return (
    <ul className="sub-trace">
      {lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * One child pi process: its task, the tools it ran while working, its final
 * words, and its token bill. Expands for the full output.
 */
function Child({ child, index }: { child: SubagentResult; index?: number }) {
  const [open, setOpen] = useState(false);
  const failed = child.status === "failed" || child.status === "aborted";
  const label = index !== undefined ? `Step ${index + 1}` : child.agent;
  return (
    <div className={`sub-child ${statusClass[child.status]} ${open ? "is-open" : ""}`}>
      <button className="sub-child-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <StatusIcon status={child.status} />
        <span className="sub-child-name">{label}</span>
        <span className={`sub-child-task ${child.status === "running" || child.status === "pending" ? "shimmer" : ""}`}>
          {child.task || (child.status === "pending" ? "waiting" : "")}
        </span>
        <span className="sub-child-usage">{usageText(child.usage)}</span>
        <ChevronRightIcon size={13} className="sub-chevron" />
      </button>
      {open && (
        <div className="sub-child-body">
          {child.trace && <Trace lines={child.trace} />}
          {child.output ? (
            failed ? (
              <pre className="sub-child-error">{child.output}</pre>
            ) : (
              <div className="sub-child-output">
                <Markdown text={child.output} />
              </div>
            )
          ) : child.status === "running" ? (
            <span className="shimmer">Working…</span>
          ) : (
            <span className="sub-child-empty">(no output)</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The body of an open subagent card: the children, laid out per mode, plus
 * the aggregate token bill. Falls back to the plain text result when the
 * structured details are missing.
 */
export function SubagentCard({
  details,
  result,
  isError,
  args,
  done,
}: {
  details: SubagentDetails | null;
  result?: string;
  isError?: boolean;
  args?: Record<string, unknown>;
  done: boolean;
}) {
  if (!details) {
    // No structured details: show the plain result, like any other tool.
    return (
      <div className="tool-call-body">
        {args && Object.keys(args).length > 0 && <pre>{JSON.stringify(args, null, 2)}</pre>}
        {done ? <pre className="tool-call-result">{result || "(no output)"}</pre> : <span className="shimmer">Running</span>}
      </div>
    );
  }

  const { mode, results } = details;
  const totalUsage = results.reduce(
    (acc, r) => ({
      input: acc.input + (r.usage?.input ?? 0),
      output: acc.output + (r.usage?.output ?? 0),
      turns: acc.turns + (r.usage?.turns ?? 0),
      contextTokens: acc.contextTokens + (r.usage?.contextTokens ?? 0),
    }),
    { input: 0, output: 0, turns: 0, contextTokens: 0 },
  );
  const anyFailed = results.some((r) => r.status === "failed" || r.status === "aborted");
  const headerClass = isError || anyFailed ? "is-bad" : done ? "is-ok" : "is-busy";

  return (
    <div className="subagent-card">
      <div className={`subagent-header ${headerClass}`}>
        <span className="subagent-mode">{mode}</span>
        <span className="subagent-count">
          {mode === "single"
            ? results[0]?.agent ?? ""
            : mode === "parallel"
              ? `${results.filter((r) => r.status === "completed").length}/${results.length} tasks`
              : `${results.filter((r) => r.status === "completed").length}/${results.length} steps`}
        </span>
        <span className="subagent-total">{done && totalUsage.turns ? usageText(totalUsage) : ""}</span>
      </div>
      <div className="subagent-children">
        {mode === "single" && results.map((r, i) => <Child key={i} child={r} />)}
        {mode === "parallel" && results.map((r, i) => <Child key={i} child={r} />)}
        {mode === "chain" && results.map((r, i) => <Child key={i} child={r} index={r.step ?? i} />)}
      </div>
      {/* The parent's own words about the result, if any beyond the children. */}
      {done && result && mode !== "single" && results.every((r) => !r.output) && (
        <pre className="tool-call-result subagent-fallback">{result}</pre>
      )}
    </div>
  );
}
