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
import { deleteChat, isSafeId, readAll, settingOn, writeBackup, writeChat, writeState } from "./data.ts";
import { piRuns, runPi, sendToRun, stopAllPi, type PiEndpoint, type PiRunRequest } from "./pi.ts";
import { randomUUID } from "node:crypto";
import { ensureVoice, stopVoice, voiceStatus, voiceTarget } from "./voice.ts";
import { freePort, waitUntilAnswering } from "./net.ts";

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
}

// Browsers and download tools write to these before renaming to .gguf.
const PARTIAL = /\.gguf\.(part|crdownload|download|incomplete|tmp)$/i;
const ACTIVE_MS = 20_000;

async function describe(path: string, fileName: string): Promise<LocalModel> {
  const info = await stat(path);
  const header = await readHeader(path, info.size).catch(() => undefined);
  const total = header?.total;
  const partial = PARTIAL.test(fileName);
  const recent = Date.now() - info.mtimeMs < ACTIVE_MS;
  const complete = total !== undefined ? info.size >= total : !partial && !recent;
  return {
    path,
    name: fileName.replace(PARTIAL, "").replace(/\.gguf$/i, ""),
    size: info.size,
    total,
    state: complete ? "ready" : recent ? "downloading" : "incomplete",
    reasoning: reasoningSupport(header?.chatTemplate),
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

interface LocalServer {
  key: string;
  model: string;
  port: number;
  process: ChildProcess;
  log: string[];
  ready: Promise<void>;
  /** Tokens per conversation, as llama-server reports it once running. */
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
  const stopped = () => {
    if (server.process.exitCode === null) return undefined;
    const log = server.log.slice(-15).join("\n");
    const hint = /out of memory|unable to allocate CUDA/i.test(log)
      ? "Not enough VRAM for this model. Clear GPU layers in Settings so it fits automatically, or set a lower number.\n\n"
      : "";
    return new Error(`${hint}llama-server exited (code ${server.process.exitCode}).\n${log}`);
  };
  return waitUntilAnswering(`http://127.0.0.1:${server.port}/health`, timeoutMs, stopped, "llama-server did not become ready in time");
}

/** The context size llama-server actually settled on, which may differ from the one asked for. */
async function readContextWindow(port: number): Promise<number | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/props`);
    if (!res.ok) return undefined;
    const props = await res.json();
    return props.default_generation_settings?.n_ctx ?? props.n_ctx;
  } catch {
    return undefined;
  }
}

interface EnsureRequest {
  model: string;
  binary?: string;
  gpuLayers?: string;
  contextSize?: string;
  /** "q8_0" stores the context cache at half size, so twice the context fits. Empty keeps llama-server's f16. */
  kvCache?: string;
  extraArgs?: string;
}

/** Returns the running server, plus how long loading took when this call started it. */
async function ensureLocal(options: EnsureRequest): Promise<{ server: LocalServer; loadMs?: number }> {
  const binary = expandHome(options.binary?.trim() || "llama-server");
  const args = ["-m", options.model, "--host", "127.0.0.1", "--jinja"];
  if (options.gpuLayers?.trim()) args.push("-ngl", options.gpuLayers.trim());
  if (options.contextSize?.trim()) args.push("-c", options.contextSize.trim());
  if (options.kvCache === "q8_0") args.push("-ctk", "q8_0", "-ctv", "q8_0");
  if (options.extraArgs?.trim()) args.push(...options.extraArgs.trim().split(/\s+/));
  const key = JSON.stringify([binary, args]);
  if (local?.key === key && local.process.exitCode === null) {
    await local.ready;
    return { server: local };
  }
  stopLocal();
  const startedAt = Date.now();
  const port = await freePort();
  const child = spawn(binary, [...args, "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  const server: LocalServer = { key, model: options.model, port, process: child, log: [], ready: Promise.resolve() };
  const collect = (data: Buffer) => {
    server.log.push(...data.toString().split("\n").filter(Boolean));
    if (server.log.length > 200) server.log.splice(0, server.log.length - 200);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const spawnError = new Promise<never>((_, reject) =>
    child.on("error", (error) =>
      reject(new Error(`Could not start ${binary}: ${error.message}. Install llama.cpp or set the binary path in Settings.`)),
    ),
  );
  server.ready = Promise.race([waitForHealth(server, 10 * 60_000), spawnError]);
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

/** The folders inside `dir`, for the folder browser. Hidden ones come last. */
async function listFolders(dir: string) {
  const path = resolve(expandHome(dir || "~"));
  const entries = await readdir(path, { withFileTypes: true });
  const folders = entries
    .filter((e) => e.isDirectory() || (e.isSymbolicLink() && !e.name.startsWith(".")))
    .map((e) => e.name)
    .sort((x, y) => Number(x.startsWith(".")) - Number(y.startsWith(".")) || x.localeCompare(y));
  return { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), folders };
}

interface PiRequest extends PiRunRequest {
  provider: { adapter: string; settings: Record<string, string> };
  model: string;
}

/** Works out where pi should send model requests, starting llama-server first for a local GGUF. */
async function piEndpoint({ provider, model }: PiRequest): Promise<{ endpoint: PiEndpoint; initial: object[] }> {
  const { adapter, settings } = provider;
  if (adapter === "llamacpp") {
    const { server, loadMs } = await ensureLocal({ ...settings, model });
    server.contextWindow ??= await readContextWindow(server.port);
    const header = await readHeader(server.model, (await stat(server.model)).size).catch(() => undefined);
    const reasoning = reasoningSupport(header?.chatTemplate);
    return {
      endpoint: {
        api: "openai-completions",
        // Through the daemon rather than straight to llama-server; see /api/llama/ in handle().
        baseUrl: `http://127.0.0.1:${process.env.API_PORT}/api/llama/v1`,
        model: basename(server.model).replace(/\.gguf$/i, ""),
        reasoning: !!reasoning?.toggle,
        contextWindow: server.contextWindow,
        // Qwen and Gemma switch thinking through the chat template, not an effort field.
        byThinkingLevel: reasoning?.toggle
          ? Object.fromEntries(["off", "minimal", "low", "medium", "high"].map((level) => [level, { chat_template_kwargs: { enable_thinking: level !== "off" } }]))
          : undefined,
        local: true,
      },
      initial: [{ type: "usage", loadMs, contextWindow: server.contextWindow, modelContext: header?.trainedContext }],
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
  if (local || voiceStatus().state === "running") console.log("No page open: stopping the models.");
  stopLocal();
  stopVoice();
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

export async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith("/api/")) return next();
  if (isCrossSite(req)) return sendJson(res, 403, { error: "Cross-site requests are not allowed" });
  const url = new URL(req.url, "http://localhost");
  try {
    // pi reaches llama-server through here. Bun, which pi runs on, reuses a connection
    // llama-server has closed after a few requests and fails with ECONNRESET; Node does not.
    if (url.pathname.startsWith("/api/llama/")) {
      if (!local || local.process.exitCode !== null) return sendJson(res, 503, { error: "llama-server is not running" });
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
    if (url.pathname.startsWith("/api/data/chats/")) {
      const id = url.pathname.slice("/api/data/chats/".length);
      if (!isSafeId(id)) return sendJson(res, 400, { error: "Bad chat id" });
      if (req.method === "PUT") await writeChat(id, await readJson(req));
      else if (req.method === "DELETE") await deleteChat(id);
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
        const header = await readHeader(server.model, (await stat(server.model)).size).catch(() => undefined);
        server.contextWindow ??= await readContextWindow(server.port);
        return sendJson(res, 200, {
          port: server.port,
          model: basename(server.model),
          loadMs,
          reasoning: reasoningSupport(header?.chatTemplate),
          contextWindow: server.contextWindow,
          modelContext: header?.trainedContext,
        });
      }
      case "/api/fs/folders":
        try {
          return sendJson(res, 200, await listFolders(url.searchParams.get("dir") ?? ""));
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
        return sendJson(res, 200, local ? { running: true, port: local.port, model: basename(local.model), log: local.log.slice(-30) } : { running: false });
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
const DAEMON_FILES = ["server/api.ts", "server/daemon.ts", "server/data.ts", "server/gguf.ts", "server/pi.ts"];
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

/** What is running and whether it is up to date, for the read_status tool. */
export async function appStatus(restartPending: string | null) {
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
    llamaServer: local
      ? { running: local.process.exitCode === null, model: basename(local.model), port: local.port, pid: local.process.pid, contextWindow: local.contextWindow }
      : { running: false },
    restartPending,
  };
}

/** Stops every pi run and llama-server, before the daemon exits. */
export function stopAll() {
  stopAllPi();
  stopLocal();
  stopVoice();
}

process.on("exit", stopAll);
