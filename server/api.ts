// Dev-server middleware: a streaming proxy so the browser can reach any model
// endpoint without CORS trouble, plus a launcher for local GGUF files.
import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { freemem, homedir, totalmem } from "node:os";
import { join, basename, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { readHeader, reasoningSupport, type ReasoningSupport } from "./gguf.ts";
import { deleteChat, isSafeId, readAll, writeChat, writeState } from "./data.ts";

const DROP_REQUEST_HEADERS = new Set([
  "host", "origin", "referer", "cookie", "connection", "content-length",
  "accept-encoding", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest",
]);

function expandHome(path: string) {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
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
  return found.sort((a, b) => a.name.localeCompare(b.name));
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port"))));
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
}

let local: LocalServer | null = null;

function stopLocal() {
  if (local) {
    local.process.kill("SIGTERM");
    local = null;
  }
}

async function waitForHealth(server: LocalServer, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.process.exitCode !== null) {
      const log = server.log.slice(-15).join("\n");
      const hint = /out of memory|unable to allocate CUDA/i.test(log)
        ? "Not enough VRAM for this model. Clear GPU layers in Settings so it fits automatically, or set a lower number.\n\n"
        : "";
      throw new Error(`${hint}llama-server exited (code ${server.process.exitCode}).\n${log}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("llama-server did not become ready in time");
}

interface EnsureRequest {
  model: string;
  binary?: string;
  gpuLayers?: string;
  contextSize?: string;
  extraArgs?: string;
}

/** Returns the running server, plus how long loading took when this call started it. */
async function ensureLocal(options: EnsureRequest): Promise<{ server: LocalServer; loadMs?: number }> {
  const binary = expandHome(options.binary?.trim() || "llama-server");
  const args = ["-m", options.model, "--host", "127.0.0.1", "--jinja"];
  if (options.gpuLayers?.trim()) args.push("-ngl", options.gpuLayers.trim());
  if (options.contextSize?.trim()) args.push("-c", options.contextSize.trim());
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

async function handle(req: IncomingMessage, res: ServerResponse, next: () => void) {
  if (!req.url?.startsWith("/api/")) return next();
  if (isCrossSite(req)) return sendJson(res, 403, { error: "Cross-site requests are not allowed" });
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/data/chats/")) {
      const id = url.pathname.slice("/api/data/chats/".length);
      if (!isSafeId(id)) return sendJson(res, 400, { error: "Bad chat id" });
      if (req.method === "PUT") await writeChat(id, JSON.parse((await readBody(req)).toString()));
      else if (req.method === "DELETE") await deleteChat(id);
      else return sendJson(res, 405, { error: "Use PUT or DELETE" });
      return sendJson(res, 200, { ok: true });
    }
    switch (url.pathname) {
      case "/api/data":
        return sendJson(res, 200, await readAll());
      case "/api/data/state":
        if (req.method !== "PUT") return sendJson(res, 405, { error: "Use PUT" });
        await writeState(JSON.parse((await readBody(req)).toString()));
        return sendJson(res, 200, { ok: true });
      case "/api/proxy":
        return await proxy(req, res, url);
      case "/api/local/models": {
        const dir = resolve(expandHome(url.searchParams.get("dir") || "./models"));
        const models = await listGguf(dir);
        return sendJson(res, 200, { dir, models });
      }
      case "/api/local/ensure": {
        const options = JSON.parse((await readBody(req)).toString() || "{}") as EnsureRequest;
        if (!options.model) return sendJson(res, 400, { error: "No model given" });
        const { server, loadMs } = await ensureLocal(options);
        const header = await readHeader(server.model, (await stat(server.model)).size).catch(() => undefined);
        return sendJson(res, 200, { port: server.port, model: basename(server.model), loadMs, reasoning: reasoningSupport(header?.chatTemplate) });
      }
      case "/api/system":
        return sendJson(res, 200, await systemStats());
      case "/api/local/status":
        return sendJson(res, 200, local ? { running: true, port: local.port, model: basename(local.model), log: local.log.slice(-30) } : { running: false });
      case "/api/local/stop":
        stopLocal();
        return sendJson(res, 200, { running: false });
      default:
        return sendJson(res, 404, { error: "Not found" });
    }
  } catch (error) {
    if (!res.headersSent) sendJson(res, 500, { error: (error as Error).message });
  }
}

export function apiPlugin(): Plugin {
  return {
    name: "model-harness-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
      server.httpServer?.on("close", stopLocal);
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => void handle(req, res, next));
      server.httpServer?.on("close", stopLocal);
    },
  };
}

process.on("exit", stopLocal);
