// The subagent tool's results, in the shape pi's extension reports them.
// The server sends these inside a tool event's `details` field; the view
// renders them instead of the generic JSON dump when it recognizes them.

export interface SubagentUsage {
  input: number;
  output: number;
  turns: number;
  contextTokens: number;
}

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** One child pi process: a single-mode call, one parallel task, or one chain step. */
export interface SubagentResult {
  agent: string;
  task: string;
  status: SubagentStatus;
  /** The child's last words, or its error when it failed. */
  output?: string;
  /** The child's tool calls, one line each, as it worked. */
  trace?: string[];
  usage?: SubagentUsage;
  model?: string;
  step?: number;
}

/** A subagent tool call: one child, several in parallel, or a chain of steps. */
export interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SubagentResult[];
  isError?: boolean;
}

/** True when a tool event's details are the subagent tool's structured result. */
export function isSubagentDetails(value: unknown): value is SubagentDetails {
  const d = value as SubagentDetails | null;
  return !!d && ["single", "parallel", "chain"].includes(d.mode) && Array.isArray(d.results);
}

const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : `${n}`);

/** "3 turns - ↑2.1k ↓340 - ctx 14k" — the child's token bill, compact. */
export function usageText(usage: SubagentUsage | undefined): string {
  if (!usage) return "";
  const parts = [`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`, `↑${kTokens(usage.input)}`, `↓${kTokens(usage.output)}`];
  if (usage.contextTokens) parts.push(`ctx ${kTokens(usage.contextTokens)}`);
  return parts.join(" - ");
}

/** What the card's header says while the call is in flight or just finished. */
export function subagentSummary(details: SubagentDetails, done: boolean): string {
  const { mode, results } = details;
  const active = results.filter((r) => r.status === "running" || r.status === "pending").length;
  const failed = results.filter((r) => r.status === "failed" || r.status === "aborted").length;
  if (mode === "single") {
    const r = results[0];
    if (!r) return "subagent";
    const task = r.task.length > 60 ? `${r.task.slice(0, 60)}…` : r.task;
    return done ? `${r.agent} - ${task}` : `${r.agent} - running…`;
  }
  if (mode === "parallel") {
    const doneCount = results.length - active;
    const succeeded = results.filter((r) => r.status === "completed").length;
    return done ? `${succeeded}/${results.length} tasks${failed ? `, ${failed} failed` : ""}` : `${doneCount}/${results.length} done, ${active} running…`;
  }
  const complete = results.filter((r) => r.status === "completed").length;
  return done ? `${complete}/${results.length} steps${failed ? `, ${failed} failed` : ""}` : `step ${complete + 1}/${results.length} running…`;
}
