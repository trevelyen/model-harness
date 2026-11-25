// The API, served by server/daemon.ts: a streaming proxy so the browser can
// reach any model endpoint without CORS trouble, plus a launcher for local GGUF files.
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { freemem, homedir, totalmem, userInfo } from "node:os";
import { join, basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { readHeader, reasoningSupport, type ReasoningSupport } from "./gguf.ts";
import { comfySettings, deleteChat, isSafeId, readAll, settingOn, writeBackup, writeChat, writeState } from "./data.ts";
import { piRuns, runPi, sendToRun, stopAllPi, type PiEndpoint, type PiRunRequest } from "./pi.ts";
import { randomUUID } from "node:crypto";
import { ensureVoice, stopVoice, voiceStatus, voiceTarget } from "./voice.ts";
import { checkRemoteComfy, comfyBase, comfyPort, comfyStatus, killComfy, resizeTerminal, restartComfy, startComfy, stopComfy, typeIntoComfy, watchTerminal } from "./comfy.ts";
import { freePort, waitUntilAnswering } from "./net.ts";
import { imageWorkflows } from "./image.ts";
import { deleteChatSounds, handleMake, serveSound, SOUND_MODELS, soundStatus, stopSound } from "./sound.ts";

const DROP_REQUEST_HEADERS = new Set([
  "host", "origin", "referer", "cookie", "connection", "content-length",
  "accept-encoding", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
]);

function expandHome(path: string) {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * The request's JSON body. `ifEmpty` is what an empty body stands for; without
 * it an empty body throws, so a write never saves nothing over real data.
 */
async function readJson<T>(req: IncomingMessage, ifEmpty?: object): Promise<T> {
  const text = (await readBody(req)).toString();
  return (text === "" && ifEmpty !== undefined ? ifEmpty : JSON.parse(text)) as T;
}

/** Answers 405 when the request isn't `method`. True when it answered. */
export function wrongMethod(req: IncomingMessage, res: ServerResponse, method: "POST" | "PUT") {
  if (req.method === method) return false;
  sendJson(res, 405, { error: `Use ${method}` });
  return true;
}

// The proxy forwards API keys, so refuse requests from other sites.
function isCrossSite(req: IncomingMessage) {
  return req.headers["sec-fetch-site"] === "cross-site";
}

async function proxy(req: IncomingMessage, res: ServerResponse, url: URL) {
  const target = url.searchParams.get("url");
  if (!target || !/^https?:\/\//.test(target)) {
    return sendJson(res, 400, { error: "Missing or invalid url parameter" });
  }
  return forward(req, res, target);
}

/** Sends the request on to `target` and streams the answer back. */
async function forward(req: IncomingMessage, res: ServerResponse, target: string) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST_HEADERS.has(key) && typeof value === "string") headers[key] = value;
  }
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, signal: controller.signal });
    res.statusCode = upstream.status;
    const type = upstream.headers.get("content-type");
    if (type) res.setHeader("content-type", type);
    res.setHeader("cache-control", "no-cache");
    if (!upstream.body) return res.end();
    // Rejects when the browser stops reading, which is how Stop works.
    await pipeline(Readable.fromWeb(upstream.body as never), res).catch(() => {});
  } catch (error) {
    if (controller.signal.aborted) return;
    sendJson(res, 502, { error: `Could not reach ${new URL(target).host}: ${(error as Error).message}` });
  }
}

export interface LocalModel {
  path: string;
  name: string;
  size: number;
  /** Full size from the GGUF header, when it could be read. */
  total?: number;
  state: "ready" | "downloading" | "incomplete";
  reasoning?: ReasoningSupport;
  facts?: ModelFacts;
}

/** What a model file or folder is, read from its GGUF header or config.json. */
export interface ModelFacts {
  format: "gguf" | "safetensors";
  /** GGUF `general.architecture` or config.json `architectures[0]`. */
  arch?: string;
  /** Experts per MoE layer. Missing means dense. */
  experts?: number;
  /** How the weights are stored, e.g. "Q4_K_XL", "NVFP4", "FP8". */
  quant?: string;
  /** The most tokens the model was trained to handle in one conversation. */
  trainedContext?: number;
}

// Browsers and download tools write to these before renaming to .gguf.
const PARTIAL = /\.gguf\.(part|crdownload|download|incomplete|tmp)$/i;
const ACTIVE_MS = 20_000;

// llama.cpp's general.file_type ids, for files whose name doesn't say.
const FILE_TYPES: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M",
  13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 32: "BF16", 38: "MXFP4",
};

// The quant in a name like "Qwen3.8-27B-UD-Q4_K_XL" or "Qwen3.6-35B-A3B-NVFP4".
const QUANT_NAME = /(?:^|[-_.])((?:UD-)?I?Q\d_[A-Z0-9_]+|I?Q\d_\d|[BF]F16|F32|NVFP4|MXFP4|FP8)(?=$|[-_.])/i;

function quantFromName(name: string) {
  return name.match(QUANT_NAME)?.[1].replace(/^UD-/i, "").toUpperCase();
}

async function describe(path: string, fileName: string): Promise<LocalModel> {
  const info = await stat(path);
  const header = await readHeader(path, info.size).catch(() => undefined);
  const total = header?.total;
  const partial = PARTIAL.test(fileName);
  const recent = Date.now() - info.mtimeMs < ACTIVE_MS;
  const complete = total !== undefined ? info.size >= total : !partial && !recent;
  const name = fileName.replace(PARTIAL, "").replace(/\.gguf$/i, "");
  return {
    path,
    name,
    size: info.size,
    total,
    state: complete ? "ready" : recent ? "downloading" : "incomplete",
    reasoning: reasoningSupport(header?.chatTemplate),
    facts: {
      format: "gguf",
      arch: header?.arch,
      experts: header?.experts,
      quant: quantFromName(name) ?? (header?.fileType !== undefined ? FILE_TYPES[header.fileType] : undefined),
      trainedContext: header?.trainedContext,
    },
  };
}

async function readJsonFile(path: string): Promise<Record<string, any> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** A Hugging Face checkpoint folder's chat template, from tokenizer_config.json or chat_template.jinja. */
async function folderChatTemplate(dir: string): Promise<string | undefined> {
  const fromConfig = (await readJsonFile(join(dir, "tokenizer_config.json")))?.chat_template;
  if (typeof fromConfig === "string") return fromConfig;
  return readFile(join(dir, "chat_template.jinja"), "utf8").catch(() => undefined);
}

/** A Hugging Face checkpoint folder: config.json beside .safetensors files. */
async function describeFolder(dir: string, files: string[]): Promise<LocalModel | undefined> {
  const config = await readJsonFile(join(dir, "config.json"));
  if (!config) return undefined;
  // Vision models keep the language model's settings in text_config.
  const text = config.text_config ?? config;
  let size = 0;
  for (const file of files.filter((f) => f.endsWith(".safetensors"))) size += (await stat(join(dir, file))).size;
  const name = basename(dir);
  const quantMethod = config.quantization_config?.quant_method;
  return {
    path: dir,
    name,
    size,
    state: "ready",
    reasoning: reasoningSupport(await folderChatTemplate(dir)),
    facts: {
      format: "safetensors",
      arch: Array.isArray(config.architectures) ? config.architectures[0] : undefined,
      experts: text.num_experts ?? text.num_local_experts ?? text.n_routed_experts ?? undefined,
      quant: quantFromName(name) ?? (typeof quantMethod === "string" ? quantMethod.toUpperCase() : config.torch_dtype?.toUpperCase?.()),
      trainedContext: text.max_position_embeddings,
    },
  };
}

async function listGguf(dir: string, depth = 3): Promise<LocalModel[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: LocalModel[] = [];
  const names = entries.map((e) => e.name);
  if (names.includes("config.json") && names.some((n) => n.endsWith(".safetensors"))) {
    const folder = await describeFolder(dir, names);
    if (folder) return [folder];
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await listGguf(full, depth - 1)));
    } else if ((entry.name.endsWith(".gguf") || PARTIAL.test(entry.name)) && !/mmproj|imatrix/i.test(entry.name)) {
      // Only the first shard of a split model is loadable.
      if (/-\d{5}-of-\d{5}\.gguf/.test(entry.name) && !/-00001-of-/.test(entry.name)) continue;
      found.push(await describe(full, entry.name));
    }
  }
  // Biggest first; a download counts at the size it will be when finished.
  return found.sort((a, b) => (b.total ?? b.size) - (a.total ?? a.size) || a.name.localeCompare(b.name));
}

interface SystemStats {
  ram: { used: number; total: number };
  gpus: { name: string; utilization: number; memoryUsed: number; memoryTotal: number }[];
}

async function readRam() {
  try {
    const info = await readFile("/proc/meminfo", "utf8");
    const kb = (key: string) => Number(info.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))?.[1]) * 1024;
    const total = kb("MemTotal");
    const available = kb("MemAvailable");
    if (total && available) return { used: total - available, total };
  } catch {
    // Not Linux; fall through.
  }
  return { used: totalmem() - freemem(), total: totalmem() };
}

function readGpus(): Promise<SystemStats["gpus"]> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=name,utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) return resolve([]);
        resolve(
          stdout.trim().split("\n").filter(Boolean).map((line) => {
            const [name, utilization, used, total] = line.split(",").map((v) => v.trim());
            const mib = 1024 * 1024;
            return { name, utilization: Number(utilization), memoryUsed: Number(used) * mib, memoryTotal: Number(total) * mib };
          }),
        );
      },
    );
  });
}

// Several tabs polling at once share one reading.
let lastStats: { at: number; value: Promise<SystemStats> } | null = null;

function systemStats() {
  if (!lastStats || Date.now() - lastStats.at > 1000) {
    lastStats = { at: Date.now(), value: Promise.all([readRam(), readGpus()]).then(([ram, gpus]) => ({ ram, gpus })) };
  }
  return lastStats.value;
}

// Writing to drop_caches needs root, so this only works with a passwordless sudo rule for it.
const DROP_CACHES_RULE = `${userInfo().username} ALL=(root) NOPASSWD: /usr/bin/tee /proc/sys/vm/drop_caches`;

function dropCaches(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("sync", () => {
      const child = execFile("sudo", ["-n", "tee", "/proc/sys/vm/drop_caches"], { timeout: 5000 }, (error) => resolve(!error));
      child.stdin?.end("3\n");
    });
  });
}

// The engines that run a local model. One GPU holds one at a time, so starting either stops the other.
type Engine = "llama" | "freetoken";

const ENGINE_NAMES: Record<Engine, string> = { llama: "llama-server", freetoken: "FreeToken" };

interface LocalServer {
  engine: Engine;
  startedAt: number;
  key: string;
  model: string;
  port: number;
  process: ChildProcess;
  log: string[];
  ready: Promise<void>;
  /** Tokens per conversation, as the engine reports it once running. */
  contextWindow?: number;
}

let local: LocalServer | null = null;

function stopLocal() {
  if (local) {
    local.process.kill("SIGTERM");
    local = null;
  }
}

function waitForHealth(server: LocalServer, timeoutMs: number) {
  const name = ENGINE_NAMES[server.engine];
  const stopped = () => {
    if (server.process.exitCode === null) return undefined;
    const log = server.log.slice(-15).join("\n");
    const hint = !/out of memory|unable to allocate CUDA/i.test(log)
      ? ""
      : server.engine === "llama"
        ? "Not enough VRAM for this model. Clear GPU layers in Settings so it fits automatically, or set a lower number.\n\n"
        : "Not enough VRAM for this model. Try a smaller context size.\n\n";
    return new Error(`${hint}${name} exited (code ${server.process.exitCode}).\n${log}`);
  };
  const url = `http://127.0.0.1:${server.port}/health`;
  if (server.engine === "llama") return waitUntilAnswering(url, timeoutMs, stopped, `${name} did not become ready in time`);
  // FreeToken answers /health with 200 from the start, saying "loading", "ok" or "error".
  return waitUntilAnswering(url, timeoutMs, stopped, `${name} did not become ready in time`, async (res) => {
    const health = await res.json().catch(() => ({}));
    if (health.status === "error") return new Error(`${name} failed to load the model: ${health.message ?? "no reason given"}`);
    return health.status === "ok";
  });
}

/** The context size the engine actually settled on, which may differ from the one asked for. */
async function readContextWindow(server: LocalServer): Promise<number | undefined> {
  try {
    if (server.engine === "freetoken") {
      const res = await fetch(`http://127.0.0.1:${server.port}/v1/models`);
      if (!res.ok) return undefined;
      return (await res.json()).data?.[0]?.max_model_len;
    }
    const res = await fetch(`http://127.0.0.1:${server.port}/props`);
    if (!res.ok) return undefined;
    const props = await res.json();
    return props.default_generation_settings?.n_ctx ?? props.n_ctx;
  } catch {
    return undefined;
  }
}

interface EnsureRequest {
  /** Which engine runs it. Left out means llama-server. */
  engine?: Engine;
  model: string;
  binary?: string;
  gpuLayers?: string;
  contextSize?: string;
  /** "q8_0" stores the context cache at half size, so twice the context fits. Empty keeps llama-server's f16. */
  kvCache?: string;
  extraArgs?: string;
}

/** The name requests use for a local model: its file or folder name. */
function localModelId(model: string) {
  return basename(model).replace(/\.gguf$/i, "");
}

/** What the running model says about thinking and context, from its GGUF header or checkpoint folder. */
async function localModelInfo(model: string) {
  const info = await stat(model);
  if (info.isDirectory()) {
    const config = await readJsonFile(join(model, "config.json"));
    return {
      reasoning: reasoningSupport(await folderChatTemplate(model)),
      trainedContext: (config?.text_config ?? config)?.max_position_embeddings as number | undefined,
    };
  }
  const header = await readHeader(model, info.size).catch(() => undefined);
  return { reasoning: reasoningSupport(header?.chatTemplate), trainedContext: header?.trainedContext };
}

/**
 * The environment an engine starts with. `ft` from a venv runs as if the venv were
 * activated: FlashInfer builds its kernels with the venv's own ninja, found on PATH.
 */
function engineEnv(engine: Engine, binary: string): NodeJS.ProcessEnv {
  if (engine !== "freetoken" || !binary.includes("/")) return process.env;
  const bin = dirname(resolve(binary));
  return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, VIRTUAL_ENV: dirname(bin) };
}

/** Returns the running server, plus how long loading took when this call started it. */
async function ensureLocal(options: EnsureRequest): Promise<{ server: LocalServer; loadMs?: number }> {
  const engine = options.engine ?? "llama";
  let binary: string;
  const args: string[] = [];
  if (engine === "freetoken") {
    binary = expandHome(options.binary?.trim() || "ft");
    // A fixed model id, so requests can name it without asking /v1/models first.
    args.push("serve", "--model", options.model, "--host", "127.0.0.1", "--served-model-name", localModelId(options.model));
    if (options.contextSize?.trim()) args.push("--max-seq-len-override", options.contextSize.trim());
  } else {
    binary = expandHome(options.binary?.trim() || "llama-server");
    args.push("-m", options.model, "--host", "127.0.0.1", "--jinja");
    if (options.gpuLayers?.trim()) args.push("-ngl", options.gpuLayers.trim());
    if (options.contextSize?.trim()) args.push("-c", options.contextSize.trim());
    if (options.kvCache === "q8_0") args.push("-ctk", "q8_0", "-ctv", "q8_0");
  }
  if (options.extraArgs?.trim()) args.push(...options.extraArgs.trim().split(/\s+/));
  const key = JSON.stringify([binary, args]);
  if (local?.key === key && local.process.exitCode === null) {
    await local.ready;
    return { server: local };
  }
  stopLocal();
  const startedAt = Date.now();
  const port = await freePort();
  const child = spawn(binary, [...args, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"], env: engineEnv(engine, binary) });
  const server: LocalServer = { engine, key, model: options.model, port, process: child, log: [], ready: Promise.resolve(), startedAt: Date.now() };
  const collect = (data: Buffer) => {
    server.log.push(...data.toString().split("\n").filter(Boolean));
    if (server.log.length > 200) server.log.splice(0, server.log.length - 200);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const spawnError = new Promise<never>((_, reject) =>
    child.on("error", (error) =>
      reject(
        new Error(
          engine === "llama"
            ? `Could not start ${binary}: ${error.message}. Install llama.cpp or set the binary path in Settings.`
            : `Could not start ${binary}: ${error.message}. Install FreeToken (uv pip install "freetoken[accel]") or set the ft path in Settings.`,
        ),
      ),
    ),
  );
  // FreeToken compiles its CUDA kernels the first time, which can take a while.
  server.ready = Promise.race([waitForHealth(server, (engine === "llama" ? 10 : 30) * 60_000), spawnError]);
  local = server;
  try {
    await server.ready;
  } catch (error) {
    if (local === server) local = null;
    child.kill("SIGTERM");
    throw error;
  }
  return { server, loadMs: Date.now() - startedAt };
}

const byName = (x: string, y: string) => Number(x.startsWith(".")) - Number(y.startsWith(".")) || x.localeCompare(y);

/**
 * The folders inside `dir`, for the path picker, and its files when `withFiles` is set.
 * Hidden ones come last. When `dir` is a file, lists its folder with that file `selected`.
 */
async function listFolders(dir: string, withFiles = false) {
  let path = resolve(expandHome(dir || "~"));
  let selected: string | undefined;
  if (withFiles && (await stat(path).catch(() => undefined))?.isFile()) {
    selected = basename(path);
    path = dirname(path);
  }
  const entries = await readdir(path, { withFileTypes: true });
  const folders: string[] = [];
  const files: { name: string; size: number; executable: boolean }[] = [];
  for (const e of entries) {
    // A link counts as what it points to; a broken one is left out.
    const info = e.isSymbolicLink() ? await stat(join(path, e.name)).catch(() => undefined) : e;
    if (!info) continue;
    if (info.isDirectory()) folders.push(e.name);
    else if (withFiles && info.isFile()) {
      const full = await stat(join(path, e.name)).catch(() => undefined);
      if (full) files.push({ name: e.name, size: full.size, executable: (full.mode & 0o111) !== 0 });
    }
  }
  folders.sort(byName);
  files.sort((x, y) => byName(x.name, y.name));
  return { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), folders, ...(withFiles && { files, selected }) };
}

interface PiRequest extends PiRunRequest {
  provider: { adapter: string; settings: Record<string, string> };
  model: string;
}

/** Works out where pi should send model requests, starting the local engine first for a local model. */
async function piEndpoint({ provider, model }: PiRequest): Promise<{ endpoint: PiEndpoint; initial: object[] }> {
  const { adapter, settings } = provider;
  if (adapter === "llamacpp" || adapter === "freetoken") {
    const { server, loadMs } = await ensureLocal({ ...settings, model, engine: adapter === "freetoken" ? "freetoken" : "llama" });
    server.contextWindow ??= await readContextWindow(server);
    const { reasoning, trainedContext } = await localModelInfo(server.model);
    return {
      endpoint: {
        api: "openai-completions",
        // Through the daemon rather than straight to the engine; see /api/llama/ in handle().
        baseUrl: `http://127.0.0.1:${process.env.API_PORT}/api/llama/v1`,
        model: localModelId(server.model),
        reasoning: !!reasoning?.toggle,
        contextWindow: server.contextWindow,
        // Qwen and Gemma switch thinking through the chat template, not an effort field.
        byThinkingLevel: reasoning?.toggle
          ? Object.fromEntries(["off", "minimal", "low", "medium", "high"].map((level) => [level, { chat_template_kwargs: { enable_thinking: level !== "off" } }]))
          : undefined,
        local: true,
      },
      initial: [{ type: "usage", loadMs, contextWindow: server.contextWindow, modelContext: trainedContext }],
    };
  }
  if (adapter === "openai" || adapter === "ollama") {
    const base = (settings.baseUrl || "").replace(/\/+$/, "");
    return {
      endpoint: { api: "openai-completions", baseUrl: adapter === "ollama" ? `${base}/v1` : base, apiKey: settings.apiKey, model, reasoning: false },
      initial: [],
    };
  }
  if (adapter === "anthropic") {
    return {
      endpoint: { api: "anthropic-messages", baseUrl: settings.baseUrl || "https://api.anthropic.com", apiKey: settings.apiKey, model, reasoning: true },
      initial: [],
    };
  }
  throw new Error(`pi cannot use ${adapter} models yet`);
}

/**
 * Where a voice chat's Cascade sends its words: the model picked in the app.
 * Cascade speaks OpenAI's chat completions, so a local GGUF or an OpenAI-style server.
 */
async function voiceLlm(req: IncomingMessage, res: ServerResponse) {
  const body = await readJson<PiRequest>(req, {});
  if (!body.provider || !body.model) return sendJson(res, 400, { error: "Pick a model at the top to talk to." });
  if (body.provider.adapter === "anthropic") {
    return sendJson(res, 400, { error: "Voice chats need a local GGUF or an OpenAI-style model. Pick one at the top." });
  }
  const { endpoint } = await piEndpoint(body);
  return sendJson(res, 200, { url: endpoint.baseUrl, model: endpoint.model, key: endpoint.apiKey ?? "" });
}

// Settings → Stop models when the page closes. Each open page holds a /api/presence
// stream. When the last one closes and none comes back within the grace period,
// which covers a reload, llama-server and the voice server stop. pi runs need no
// stopping: each ends when its page's reply stream closes.
const CLOSE_GRACE = 10_000;
let openPages = 0;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function presence(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(": open\n\n");
  openPages++;
  clearTimeout(closeTimer);
  // A comment now and then, so nothing between here and the page closes an idle stream.
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    openPages--;
    if (openPages === 0) closeTimer = setTimeout(() => void stopIfClosed(), CLOSE_GRACE);
  });
}

async function stopIfClosed() {
  if (openPages > 0 || !(await settingOn("stopOnClose"))) return;
  if (local || voiceStatus().state === "running" || soundStatus().state !== "stopped") console.log("No page open: stopping the models.");
  stopLocal();
  stopVoice();
  stopSound();
}

// Staff agent messages waiting for the page to run them in the child chat, by request id.
const staffWaiting = new Map<string, (answer: { reply?: string; error?: string }) => void>();

/**
 * The staffagent tool's message to a child chat. The page runs it, as if typed in
 * the child, so it streams and saves like any chat, then answers /api/staffagent/reply.
 * The request reaches the page through the parent chat's own reply stream.
 */
async function askStaff(req: IncomingMessage, res: ServerResponse) {
  const { parentId, name, message } = await readJson<{ parentId?: string; name?: string; message?: string }>(req, {});
  const staffName = name?.trim() ?? "";
  if (!parentId || !isSafeId(parentId)) return sendJson(res, 400, { error: "Bad parent chat id" });
  if (!staffName || staffName.length > 40) return sendJson(res, 400, { error: "Give the staff agent a short name, up to 40 characters." });
  if (!message?.trim()) return sendJson(res, 400, { error: "No message given" });
  const requestId = randomUUID();
  const answer = new Promise<{ reply?: string; error?: string }>((resolve) => staffWaiting.set(requestId, resolve));
  if (!sendToRun(parentId, { type: "staff", requestId, name: staffName, message })) {
    staffWaiting.delete(requestId);
    return sendJson(res, 409, { error: "The parent chat isn't replying, so there's no page to run the staff agent in." });
  }
  // The tool call stopped, for example with the parent's reply: stop waiting.
  res.on("close", () => staffWaiting.delete(requestId));
  const result = await answer;
  return sendJson(res, result.error ? 502 : 200, result);
}

/** ComfyUI's terminal output as a stream of events: what it printed so far, then each new piece. */
function comfyTerminal(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const stop = watchTerminal((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  res.on("close", () => {
    clearInterval(ping);
    stop();
  });
}

// What ComfyUI sends back, minus what no longer holds once fetch has decoded the body.
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

/** A request under /api/comfy/ui/, passed on to ComfyUI with its answer's headers kept. */
async function forwardComfy(req: IncomingMessage, res: ServerResponse, url: URL) {
  const port = comfyPort();
  if (!port) return sendJson(res, 503, { error: "ComfyUI is not running" });
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!DROP_REQUEST_HEADERS.has(key) && typeof value === "string") headers[key] = value;
  }
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await readBody(req));
  const target = `http://127.0.0.1:${port}/${url.pathname.slice("/api/comfy/ui/".length)}${url.search}`;
  try {
    const upstream = await fetch(target, { method: req.method, headers, body, redirect: "manual", signal: controller.signal });
    res.statusCode = upstream.status;
    upstream.headers.forEach((value, key) => {
      if (DROP_RESPONSE_HEADERS.has(key)) return;
      // A redirect to one of ComfyUI's own paths stays under the prefix.
      res.setHeader(key, key === "location" && value.startsWith("/") ? `/api/comfy/ui${value}` : value);
    });
    if (!upstream.body) return res.end();
    await pipeline(Readable.fromWeb(upstream.body as never), res).catch(() => {});
  } catch (error) {
    if (controller.signal.aborted) return;
    sendJson(res, 502, { error: `Could not reach ComfyUI: ${(error as Error).message}` });
  }
}

// Settings → ComfyUI. Start and restart take the folder in the body, as the page has it.
async function handleComfy(req: IncomingMessage, res: ServerResponse, url: URL) {
  const action = url.pathname.slice("/api/comfy/".length);
  if (action === "status") return sendJson(res, 200, comfyStatus());
  if (action === "check") return sendJson(res, 200, await checkRemoteComfy(url.searchParams.get("url") ?? ""));
  if (action === "terminal") return comfyTerminal(res);
  // Its frontend takes its page's folder as the base for every request, so the page needs the trailing slash.
  if (action === "ui") {
    res.writeHead(308, { location: `/api/comfy/ui/${url.search}` });
    return res.end();
  }
  if (action.startsWith("ui/")) return await forwardComfy(req, res, url);
  if (wrongMethod(req, res, "POST")) return;
  if (action === "terminal/input") {
    const { data } = await readJson<{ data?: string }>(req, {});
    if (typeof data === "string") typeIntoComfy(data);
    return sendJson(res, 200, { ok: true });
  }
  if (action === "terminal/resize") {
    const { cols, rows } = await readJson<{ cols?: number; rows?: number }>(req, {});
    resizeTerminal(Number(cols), Number(rows));
    return sendJson(res, 200, { ok: true });
  }
  const { folder = "" } = await readJson<{ folder?: string }>(req, {});
  try {
    if (action === "start") await startComfy(folder);
    else if (action === "restart") await restartComfy(folder, url.searchParams.has("hard"));
    else if (action === "stop") await stopComfy();
    else return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  return sendJson(res, 200, comfyStatus());
}

/** The image workflows, and which of ComfyUI's models each can run. */
async function handleWorkflows(res: ServerResponse) {
  let base: string;
  try {
    base = comfyBase(await comfySettings());
  } catch (error) {
    return sendJson(res, 503, { error: (error as Error).message });
  }
  try {
    return sendJson(res, 200, await imageWorkflows(base));
  } catch (error) {
    return sendJson(res, 502, { error: `Could not ask ComfyUI for its models: ${(error as Error).message}` });
  }
}

export async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith("/api/")) return next();
  if (isCrossSite(req)) return sendJson(res, 403, { error: "Cross-site requests are not allowed" });
  const url = new URL(req.url, "http://localhost");
  try {
    // pi and the page reach the local engine through here. Bun, which pi runs on, reuses a
    // connection llama-server has closed after a few requests and fails with ECONNRESET; Node does not.
    if (url.pathname.startsWith("/api/llama/")) {
      if (!local || local.process.exitCode !== null) return sendJson(res, 503, { error: "No local model is running" });
      return await forward(req, res, `http://127.0.0.1:${local.port}/${url.pathname.slice("/api/llama/".length)}${url.search}`);
    }
    if (url.pathname === "/api/voice/llm") {
      if (wrongMethod(req, res, "POST")) return;
      return await voiceLlm(req, res);
    }
    if (url.pathname === "/api/voice/status") return sendJson(res, 200, voiceStatus());
    if (url.pathname === "/api/voice/stop") {
      if (wrongMethod(req, res, "POST")) return;
      stopVoice();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/voice/")) {
      return await forward(req, res, voiceTarget(await ensureVoice(), url.pathname, url.search));
    }
    if (url.pathname.startsWith("/api/comfy/")) return await handleComfy(req, res, url);
    if (url.pathname === "/api/image/workflows") return await handleWorkflows(res);
    if (url.pathname === "/api/sound/models") return sendJson(res, 200, SOUND_MODELS);
    if (url.pathname === "/api/sound/make") {
      if (wrongMethod(req, res, "POST")) return;
      return await handleMake(await readJson(req), res);
    }
    if (url.pathname === "/api/sound/stop") {
      if (wrongMethod(req, res, "POST")) return;
      stopSound();
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname.startsWith("/api/sound/files/")) return await serveSound(req, res, url.pathname.slice("/api/sound/files/".length));
    if (url.pathname.startsWith("/api/data/chats/")) {
      const id = url.pathname.slice("/api/data/chats/".length);
      if (!isSafeId(id)) return sendJson(res, 400, { error: "Bad chat id" });
      if (req.method === "PUT") await writeChat(id, await readJson(req));
      else if (req.method === "DELETE") await Promise.all([deleteChat(id), deleteChatSounds(id)]);
      else return sendJson(res, 405, { error: "Use PUT or DELETE" });
      return sendJson(res, 200, { ok: true });
    }
    switch (url.pathname) {
      case "/api/staffagent":
        if (wrongMethod(req, res, "POST")) return;
        return await askStaff(req, res);
      case "/api/staffagent/reply": {
        if (wrongMethod(req, res, "POST")) return;
        const { requestId, reply, error } = await readJson<{ requestId?: string; reply?: string; error?: string }>(req, {});
        const resolve = requestId && staffWaiting.get(requestId);
        if (!resolve) return sendJson(res, 404, { error: "No staff agent message is waiting for that reply" });
        staffWaiting.delete(requestId);
        resolve({ reply, error });
        return sendJson(res, 200, { ok: true });
      }
      case "/api/data":
        return sendJson(res, 200, await readAll());
      case "/api/data/state":
        if (wrongMethod(req, res, "PUT")) return;
        await writeState(await readJson(req));
        return sendJson(res, 200, { ok: true });
      case "/api/data/state/backup":
        // The browser's copy with API keys included, for the home-folder backup.
        if (wrongMethod(req, res, "PUT")) return;
        await writeBackup(await readJson(req));
        return sendJson(res, 200, { ok: true });
      case "/api/proxy":
        return await proxy(req, res, url);
      case "/api/local/models": {
        const dir = resolve(expandHome(url.searchParams.get("dir") || "./models"));
        const models = await listGguf(dir);
        return sendJson(res, 200, { dir, models });
      }
      case "/api/local/ensure": {
        const options = await readJson<EnsureRequest>(req, {});
        if (!options.model) return sendJson(res, 400, { error: "No model given" });
        const { server, loadMs } = await ensureLocal(options);
        const { reasoning, trainedContext } = await localModelInfo(server.model);
        server.contextWindow ??= await readContextWindow(server);
        return sendJson(res, 200, {
          port: server.port,
          model: basename(server.model),
          modelId: localModelId(server.model),
          loadMs,
          reasoning,
          contextWindow: server.contextWindow,
          modelContext: trainedContext,
        });
      }
      case "/api/fs/folders":
        try {
          return sendJson(res, 200, await listFolders(url.searchParams.get("dir") ?? "", url.searchParams.has("files")));
        } catch (error) {
          return sendJson(res, 400, { error: `Cannot open that folder: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` });
        }
      case "/api/fs/mkdir": {
        if (wrongMethod(req, res, "POST")) return;
        const { parent, name } = await readJson<{ parent?: string; name?: string }>(req, {});
        const clean = name?.trim() ?? "";
        if (!parent || !clean || clean === "." || clean === ".." || /[/\\\0]/.test(clean)) {
          return sendJson(res, 400, { error: "That isn't a valid folder name" });
        }
        const path = join(resolve(expandHome(parent)), clean);
        try {
          await mkdir(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          return sendJson(res, 400, { error: code === "EEXIST" ? `${clean} already exists` : `Cannot make that folder: ${code ?? (error as Error).message}` });
        }
        return sendJson(res, 200, { path });
      }
      case "/api/pi/run": {
        if (wrongMethod(req, res, "POST")) return;
        const body = await readJson<PiRequest>(req, {});
        if (!isSafeId(body.conversationId)) return sendJson(res, 400, { error: "Bad chat id" });
        if (!body.cwd?.trim()) return sendJson(res, 400, { error: "pi needs a working folder. Set one in the harness panel." });
        const { endpoint, initial } = await piEndpoint(body);
        await runPi(body, endpoint, res, initial);
        return;
      }
      case "/api/presence":
        return presence(res);
      case "/api/system":
        return sendJson(res, 200, await systemStats());
      case "/api/local/status":
        return sendJson(res, 200, local && local.process.exitCode === null ? { running: true, engine: local.engine, port: local.port, model: basename(local.model), log: local.log.slice(-30) } : { running: false });
      case "/api/local/stop":
        stopLocal();
        return sendJson(res, 200, { running: false });
      case "/api/system/free": {
        stopLocal();
        const cachesDropped = await dropCaches();
        return sendJson(res, 200, cachesDropped ? { cachesDropped } : { cachesDropped, sudoRule: DROP_CACHES_RULE });
      }
      default:
        return sendJson(res, 404, { error: "Not found" });
    }
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
  }
}

// Files only a restart loads: the daemon's code, and what Vite reads at start.
const DAEMON_FILES = ["server/api.ts", "server/daemon.ts", "server/data.ts", "server/gguf.ts", "server/net.ts", "server/pi.ts", "server/sound.ts", "server/voice.ts", "server/comfy.ts", "server/image.ts"];
const APP_FILES = ["vite.config.ts", "package.json"];
const daemonStartedAt = Date.now();
let appStartedAt = Number(process.env.APP_STARTED_AT) || daemonStartedAt;

/** Records that Vite started again, so its changes count as loaded. */
export function appRestarted() {
  appStartedAt = Date.now();
}

/** The files in `files` changed since `since`, which the running code has not loaded. */
async function changedSince(files: string[], since: number) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const changed: string[] = [];
  for (const file of files) {
    const info = await stat(join(root, file)).catch(() => undefined);
    if (info && info.mtimeMs > since) changed.push(file);
  }
  return changed;
}

/** Runs a command and returns what it printed, or "" if it failed or isn't installed. */
function output(command: string, args: string[]) {
  return new Promise<string>((resolve) => execFile(command, args, { timeout: 3000 }, (error, stdout) => resolve(error ? "" : stdout)));
}

/**
 * GPU memory in bytes for each process in `pids`, counting their children too:
 * the voice server's models load in a Python process uv started under it.
 */
async function gpuMemory(pids: number[]) {
  const [apps, table] = await Promise.all([
    output("nvidia-smi", ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"]),
    output("ps", ["-eo", "pid=,ppid="]),
  ]);
  const used = new Map<number, number>();
  for (const line of apps.trim().split("\n").filter(Boolean)) {
    const [pid, mib] = line.split(",").map((v) => Number(v.trim()));
    used.set(pid, (used.get(pid) ?? 0) + mib * 1024 * 1024);
  }
  const children = new Map<number, number[]>();
  for (const line of table.trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const total = (pid: number): number => (used.get(pid) ?? 0) + (children.get(pid) ?? []).reduce((sum, child) => sum + total(child), 0);
  return Object.fromEntries(pids.map((pid) => [pid, total(pid)]));
}

/**
 * What is running and whether it is up to date, for the read_status tool and
 * Settings → Services. `detail` adds GPU memory and recent output, which the
 * tool doesn't need.
 */
export async function appStatus(restartPending: string | null, detail = false) {
  const llama = local && local.process.exitCode === null ? local : null;
  const voice = voiceStatus();
  const sound = soundStatus();
  const comfy = comfyStatus();
  const pids = [
    llama?.process.pid,
    voice.state === "stopped" ? undefined : voice.pid,
    sound.state === "stopped" ? undefined : sound.pid,
    comfy.state === "stopped" ? undefined : comfy.pid,
  ]
    .filter((pid): pid is number => !!pid);
  const gpu = detail ? await gpuMemory(pids) : {};
  return {
    app: {
      startedAt: new Date(appStartedAt).toISOString(),
      pagePort: Number(process.env.PORT) || undefined,
      apiPort: Number(process.env.API_PORT),
      unloadedChanges: await changedSince(APP_FILES, appStartedAt),
    },
    daemon: {
      pid: process.pid,
      startedAt: new Date(daemonStartedAt).toISOString(),
      unloadedChanges: await changedSince(DAEMON_FILES, daemonStartedAt),
    },
    piRuns: piRuns().map((r) => ({ chat: r.conversationId, startedAt: new Date(r.startedAt).toISOString() })),
    llamaServer: llama
      ? {
          running: true,
          engine: llama.engine,
          model: basename(llama.model),
          port: llama.port,
          pid: llama.process.pid,
          contextWindow: llama.contextWindow,
          startedAt: new Date(llama.startedAt).toISOString(),
          ...(detail && { gpuMemory: gpu[llama.process.pid!], log: llama.log.slice(-30) }),
        }
      : { running: false },
    voiceServer: voice.state === "stopped" ? voice : detail ? { ...voice, gpuMemory: gpu[voice.pid!] } : { ...voice, log: undefined },
    soundServer: sound.state === "stopped" ? sound : detail ? { ...sound, gpuMemory: gpu[sound.pid] } : { ...sound, log: undefined },
    comfy: comfy.state === "stopped" ? comfy : detail ? { ...comfy, gpuMemory: gpu[comfy.pid] } : { ...comfy, log: undefined },
    restartPending,
  };
}

/** Stops every pi run and the local engine, before the daemon exits. */
export function stopAll() {
  stopAllPi();
  stopLocal();
  stopVoice();
  stopSound();
  killComfy();
}

process.on("exit", stopAll);
