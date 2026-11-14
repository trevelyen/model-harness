// Runs the pi coding agent for one chat message. pi is started in RPC mode,
// pointed at the chat's model through a models.json of its own, and its
// event stream is turned into the app's chat events, one JSON object a line.
import type { ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

function resultText(result: { content?: { type: string; text?: string }[] } | undefined) {
  const text = (result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n… ${text.length - MAX_RESULT} more characters` : text;
}

/** Streams one pi run to `res` as chat events, ending with the run or on Stop. `initial` events go first. */
export async function runPi(run: PiRunRequest, endpoint: PiEndpoint, res: ServerResponse, initial: object[] = []) {
  const cwd = resolve(expandHome(run.cwd.trim()));
  const info = await stat(cwd).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`The working folder ${cwd} does not exist. Set it in the harness panel.`);
  await writeModels(endpoint, run.params);

  res.statusCode = 200;
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-cache");
  const send = (event: object) => res.write(`${JSON.stringify(event)}\n`);
  initial.forEach(send);
  send({ type: "status", text: "Starting pi" });

  const args = ["--mode", "rpc", "--no-approve", "--offline", "--session-dir", join(PI_DIR, "sessions"), "--session-id", run.conversationId];
  args.push("--provider", PROVIDER, "--model", endpoint.model);
  if (run.thinking) args.push("--thinking", run.thinking);
  if (run.systemPrompt?.trim()) args.push("--system-prompt", run.systemPrompt);
  const command = expandHome(run.command?.trim() || "pi");
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PI_CODING_AGENT_DIR: PI_DIR, MODEL_HARNESS_API_KEY: endpoint.apiKey || "none" },
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
      case "tool_execution_end":
        send({ type: "tool", id: record.toolCallId, name: record.toolName, result: resultText(record.result), isError: record.isError, done: true });
        break;
      case "agent_settled":
        finish();
        break;
    }
  }

  child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: run.message })}\n`);
}
