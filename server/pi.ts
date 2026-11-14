// Runs the pi coding agent for one chat message. pi is started in RPC mode,
// pointed at the chat's model through a models.json of its own, and its
// event stream is turned into the app's chat events, one JSON object a line.
import type { ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pi's settings, sessions and models.json live here, away from ~/.pi.
const PI_DIR = join(resolve(process.env.MODEL_HARNESS_DATA || "data"), "pi");
const PROVIDER = "harness";
const MAX_RESULT = 4000;

/** Where pi should send model requests. The server works this out from the chat's provider. */
export interface PiEndpoint {
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  apiKey?: string;
  model: string;
  reasoning: boolean;
  contextWindow?: number;
  /** Extra request fields per thinking level, such as Qwen's switch for thinking. */
  byThinkingLevel?: Record<string, Record<string, unknown>>;
  local?: boolean;
}

export interface PiRunRequest {
  conversationId: string;
  message: string;
  /** The folder pi works in. Its tools can read, change and run anything in it. */
  cwd: string;
  command?: string;
  systemPrompt?: string;
  /** "off" or an effort level. Left out when the model cannot think. */
  thinking?: string;
  params: { temperature?: number; topP?: number; topK?: number; minP?: number; maxTokens?: number };
  /** Every tool this harness gives pi, its own and the app's. Left out, pi uses its defaults. */
  tools?: string[];
  /** The hooks pi runs, from pi-extensions/harness-hooks.ts. */
  hooks?: string[];
  /** Agent loop settings. A field left out keeps pi's default. */
  loop?: {
    maxSteps?: number;
    compaction?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
    retry?: boolean;
    maxRetries?: number;
  };
}

// The app's own tools for pi, which this extension adds.
const HARNESS_TOOLS = fileURLToPath(new URL("../pi-extensions/harness-tools.ts", import.meta.url));
const APP_TOOLS = new Set(["read_status", "restart_daemon", "restart_app", "staffagent"]);
// Always loaded: gives write results a patch, as edit results already have, for the changes pane.
const HARNESS_CHANGES = fileURLToPath(new URL("../pi-extensions/harness-changes.ts", import.meta.url));
// Tells the model to restart once it has finished, when it is editing this app with hot reload off.
const HARNESS_SELF = fileURLToPath(new URL("../pi-extensions/harness-self.ts", import.meta.url));
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));
// The hooks, and the step limit, which this extension runs.
const HARNESS_HOOKS = fileURLToPath(new URL("../pi-extensions/harness-hooks.ts", import.meta.url));

// Every pi still running, so a restart can stop them all, or wait for them.
const running = new Map<ChildProcess, { conversationId: string; startedAt: number }>();
const idleListeners: (() => void)[] = [];

/** Stops every pi run. Their sessions are on disk, so each chat carries on with its next message. */
export function stopAllPi() {
  for (const child of running.keys()) child.kill("SIGTERM");
  running.clear();
}

// Each replying chat's event stream, so a staff agent request can reach the page through it.
const streams = new Map<string, (event: object) => void>();

/** Adds an event to a running chat's stream. False when that chat isn't replying. */
export function sendToRun(conversationId: string, event: object) {
  const send = streams.get(conversationId);
  send?.(event);
  return !!send;
}

/** The pi runs in progress, one per chat that is replying. */
export function piRuns() {
  return [...running.values()];
}

/** Calls `listener` once no pi run is left, straight away if none is running. */
export function whenPiIdle(listener: () => void) {
  if (running.size === 0) listener();
  else idleListeners.push(listener);
}

const expandHome = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path);

async function writeModels(endpoint: PiEndpoint, params: PiRunRequest["params"]) {
  const sampling = Object.fromEntries(
    Object.entries({ temperature: params.temperature, top_p: params.topP, top_k: params.topK, min_p: params.minP }).filter(([, v]) => v !== undefined),
  );
  const contextWindow = endpoint.contextWindow ?? 128000;
  const models = {
    providers: {
      [PROVIDER]: {
        baseUrl: endpoint.baseUrl,
        api: endpoint.api,
        // The key reaches pi through its environment, so it is never written here.
        apiKey: "$MODEL_HARNESS_API_KEY",
        // llama-server takes plain OpenAI requests, not the newer fields pi would guess at.
        compat: endpoint.local ? { supportsReasoningEffort: false, supportsDeveloperRole: false, maxTokensField: "max_tokens" } : undefined,
        models: [
          {
            id: endpoint.model,
            reasoning: endpoint.reasoning,
            contextWindow,
            maxTokens: Math.min(params.maxTokens ?? 16384, contextWindow),
            samplingParams: endpoint.api === "openai-completions" && Object.keys(sampling).length ? sampling : undefined,
            samplingParamsByThinkingLevel: endpoint.byThinkingLevel,
          },
        ],
      },
    },
  };
  await mkdir(PI_DIR, { recursive: true });
  await writeFile(join(PI_DIR, "models.json"), JSON.stringify(models, null, 2));
}

/** Whether `path` is `root` or a folder inside it. */
function isInside(path: string, root: string) {
  const inside = relative(root, path);
  return !inside.startsWith("..") && !isAbsolute(inside);
}

/** Settings → Hot reload, which the app saves with its other settings. Off unless set. */
async function hotReloadOn() {
  try {
    return JSON.parse(await readFile(join(resolve(process.env.MODEL_HARNESS_DATA || "data"), "state.json"), "utf8")).hotReload === true;
  } catch {
    return false;
  }
}

/** Sets pi's compaction and retry settings for the next run, keeping the rest of its settings.json. */
async function writeSettings(loop: PiRunRequest["loop"] = {}) {
  const path = join(PI_DIR, "settings.json");
  const settings = JSON.parse(await readFile(path, "utf8").catch(() => "{}"));
  // Fields left out are dropped, so pi falls back to its own defaults.
  const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  settings.compaction = defined({ enabled: loop.compaction, reserveTokens: loop.reserveTokens, keepRecentTokens: loop.keepRecentTokens });
  settings.retry = defined({ enabled: loop.retry, maxRetries: loop.maxRetries });
  await mkdir(PI_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2));
}

function resultText(result: { content?: { type: string; text?: string }[] } | undefined) {
  const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… ${text.length - MAX_RESULT} more characters` : text;
}

// The subagent tool's structured result, re-shaped for the view: each child
// gets a compact tool-call trace and its final output, so the browser does
// not have to walk the child's raw messages.
function subagentDetails(details: any): any {
  if (!details || !Array.isArray(details.results)) return details;
  const line = (name: string, args: any = {}) => {
    const s = (k: string) => (typeof args[k] === "string" ? args[k] : undefined);
    const home = (p: string) => p.replace(/^\/home\/[^/]+/, "~");
    switch (name) {
      case "bash": return "$ " + (s("command") ?? "");
      case "read": return "read " + home(s("file_path") || s("path") || "");
      case "write": return "write " + home(s("file_path") || s("path") || "");
      case "edit": return "edit " + home(s("file_path") || s("path") || "");
      case "ls": return "ls " + home(s("path") || ".");
      case "find": return `find ${s("pattern") ?? "*"} in ${home(s("path") || ".")}`;
      case "grep": return `grep /${s("pattern") ?? ""}/ in ${home(s("path") || ".")}`;
      default: {
        const j = JSON.stringify(args);
        return `${name} ${j.length > 40 ? j.slice(0, 40) + "…" : j}`;
      }
    }
  };
  const finalText = (messages: any[] = []) => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "assistant") continue;
      for (const part of m.content ?? []) if (part.type === "text") return part.text;
    }
    return "";
  };
  const results = details.results.map((r: any) => {
    const trace: string[] = [];
    for (const m of r.messages ?? []) {
      if (m?.role !== "assistant") continue;
      for (const part of m.content ?? []) if (part.type === "toolCall") trace.push(line(part.name, part.arguments));
    }
    const output = r.status === "failed" || r.status === "aborted"
      ? [r.errorMessage?.trim(), r.stderr?.trim(), finalText(r.messages)].filter(Boolean).join("\n\n") || "(no output)"
      : finalText(r.messages) || "";
    return {
      agent: r.agent,
      task: r.task,
      status: r.status,
      step: r.step,
      model: r.model,
      usage: r.usage ? { input: r.usage.input, output: r.usage.output, turns: r.usage.turns, contextTokens: r.usage.contextTokens } : undefined,
      trace: trace.slice(-40),
      output,
    };
  });
  return { mode: details.mode, results, isError: details.isError };
}

/** Streams one pi run to `res` as chat events, ending with the run or on Stop. `initial` events go first. */
export async function runPi(run: PiRunRequest, endpoint: PiEndpoint, res: ServerResponse, initial: object[] = []) {
  const cwd = resolve(expandHome(run.cwd.trim()));
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`The working folder ${cwd} does not exist. Set it in the harness panel.`);
  await writeModels(endpoint, run.params);
  await writeSettings(run.loop);

  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-cache");
  const send = (event: object) => res.write(`${JSON.stringify(event)}\n`);
  streams.set(run.conversationId, send);
  initial.forEach(send);
  send({ type: "status", text: "Starting pi" });

  const args = ["--mode", "rpc", "--no-approve", "--offline", "--session-dir", join(PI_DIR, "sessions"), "--session-id", run.conversationId];
  args.push("--provider", PROVIDER, "--model", endpoint.model);
  if (run.thinking) args.push("--thinking", run.thinking);
  if (run.systemPrompt?.trim()) args.push("--system-prompt", run.systemPrompt);
  args.push("-e", HARNESS_CHANGES);
  const appTools = (run.tools ?? []).filter((t) => APP_TOOLS.has(t));
  if (appTools.length) args.push("-e", HARNESS_TOOLS);
  const hooks = run.hooks ?? [];
  const maxSteps = run.loop?.maxSteps ?? 0;
  if (hooks.length || maxSteps) args.push("-e", HARNESS_HOOKS);
  if (isInside(cwd, APP_ROOT) && !(await hotReloadOn())) args.push("-e", HARNESS_SELF);
  // The list is exact: anything left out, built in or from an extension, is off.
  if (run.tools) args.push(...(run.tools.length ? ["--tools", run.tools.join(",")] : ["--no-tools"]));
  const command = expandHome(run.command?.trim() || "pi");
  // The app's ports stay out of pi's environment, so nothing it starts can take them.
  const { PORT: _port, HOST: _host, API_PORT: apiPort, ...env } = process.env;
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...env,
      PI_CODING_AGENT_DIR: PI_DIR,
      MODEL_HARNESS_API_KEY: endpoint.apiKey || "none",
      // For the harness tools: where the daemon is, which run this is, and which tools are on.
      MODEL_HARNESS_API: `http://127.0.0.1:${apiPort}`,
      MODEL_HARNESS_RUN_ID: run.conversationId,
      MODEL_HARNESS_TOOLS: appTools.join(","),
      MODEL_HARNESS_HOOKS: hooks.join(","),
      MODEL_HARNESS_MAX_STEPS: String(maxSteps),
    },
  });
  running.set(child, { conversationId: run.conversationId, startedAt: Date.now() });
  child.on("exit", () => {
    running.delete(child);
    if (running.size === 0) idleListeners.splice(0).forEach((listener) => listener());
  });

  const stderr: string[] = [];
  child.stderr.on("data", (data: Buffer) => {
    stderr.push(data.toString());
    if (stderr.length > 50) stderr.shift();
  });

  let finished = false;
  const finish = (error?: string) => {
    if (finished) return;
    finished = true;
    if (streams.get(run.conversationId) === send) streams.delete(run.conversationId);
    if (error) send({ type: "error", message: error });
    res.end();
    // Closing stdin asks pi to shut down; the timer catches one that will not.
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 5000).unref();
  };

  // Stop in the browser closes the request: abort the run, then shut pi down.
  res.on("close", () => {
    if (finished || child.exitCode !== null) return;
    child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`);
    finish();
  });

  child.on("error", (error) => finish(`Could not start ${command}: ${error.message}. Install pi or set its command in the harness panel.`));
  child.on("exit", (code) => finish(`pi exited (code ${code}) before finishing.\n${stderr.join("").trim().slice(-1500)}`));

  // Split on LF only: pi's JSON strings may hold U+2028, which readline would split on.
  let buffer = "";
  child.stdout.on("data", (data: Buffer) => {
    buffer += data.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        // Not a protocol record; pi keeps diagnostics on stderr, so this is rare.
      }
    }
  });

  let turns = 0;
  function handle(record: Record<string, any>) {
    switch (record.type) {
      case "response":
        if (!record.success) finish(record.error ?? `pi refused the ${record.command} command`);
        break;
      case "turn_start":
        if (turns++ === 0) send({ type: "status", text: "Working" });
        break;
      case "message_update": {
        const event = record.assistantMessageEvent;
        if (event.type === "text_delta") send({ type: "text", text: event.delta });
        else if (event.type === "thinking_delta") send({ type: "reasoning", text: event.delta });
        const usage = record.usage;
        if (usage?.totalTokens) {
          send({ type: "usage", inputTokens: usage.input + usage.cacheRead + usage.cacheWrite, outputTokens: usage.output, cachedTokens: usage.cacheRead || undefined });
        }
        break;
      }
      case "message_end":
        if (record.message?.role === "assistant" && record.message.stopReason === "error") {
          finish(record.message.errorMessage ?? "The model returned an error");
        }
        break;
      case "tool_execution_start":
        send({ type: "tool", id: record.toolCallId, name: record.toolName, args: record.args });
        break;
      case "tool_execution_update":
        // Live progress from a tool that reports it, such as subagent's per-child status.
        send({ type: "tool", id: record.toolCallId, name: record.toolName, args: record.args, details: record.toolName === "subagent" ? subagentDetails(record.partialResult?.details) : record.partialResult?.details });
        break;
      case "tool_execution_end":
        // `details` carries the tool's structured result, which the view can render richly.
        send({ type: "tool", id: record.toolCallId, name: record.toolName, result: resultText(record.result), details: record.toolName === "subagent" ? subagentDetails(record.result?.details) : record.result?.details, isError: record.isError, done: true });
        // A file the model changed, for the changes pane. Paths are shown relative to the working folder.
        if (!record.isError && typeof record.result?.details?.patch === "string" && record.result.details.patch) {
          const patch: string = record.result.details.patch;
          // The end event has no arguments, but the patch names the file on its "+++" line.
          const file = patch.match(/^\+\+\+ (.+)$/m)?.[1]?.trim() ?? "";
          send({ type: "change", path: relative(cwd, resolve(cwd, file)), patch });
        }
        break;
      case "agent_settled":
        finish();
        break;
    }
  }

  child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: run.message })}\n`);
}
