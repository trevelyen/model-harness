// ComfyUI, run from a folder the user picks in Settings → ComfyUI. Unlike the
// voice server it never starts by itself: the settings' Start button starts it.
// A remote ComfyUI is only checked, since the app can't start or stop it.
//
// It runs in a pty, so it prints as it would in a terminal: colours, and progress
// bars that redraw in place. The page shows that output in a terminal of its own,
// streamed from /api/comfy/terminal, and can type into it.
//
// The page reaches ComfyUI's own UI through the daemon, at /api/comfy/ui/, so it
// works wherever the page does, not just on this machine. ComfyUI's frontend builds
// every address from its page's path, its websocket included, so all of it stays
// under that prefix.
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import { freePort, waitUntilAnswering } from "./net.ts";

// The first start may install custom nodes' requirements, so it gets a while.
const START_TIMEOUT = 5 * 60_000;
// How long Stop waits for ComfyUI to exit before killing it.
const STOP_GRACE = 10_000;
// How much output a terminal opened later gets to catch up on.
const SCROLLBACK = 512 * 1024;

interface ComfyServer {
  folder: string;
  port: number;
  pty: IPty;
  exited: Promise<void>;
  exitCode: number | null;
  ready: Promise<void>;
  startedAt: number;
  listening: boolean;
}

export type TerminalEvent = { type: "reset"; data: string } | { type: "data"; data: string };

let comfy: ComfyServer | null = null;
// The last run's output. It stays after ComfyUI stops, so the terminal still shows why.
let screen = "";
let size = { cols: 120, rows: 30 };
const watchers = new Set<(event: TerminalEvent) => void>();

function emit(event: TerminalEvent) {
  for (const watcher of watchers) watcher(event);
}

function write(data: string) {
  screen += data;
  if (screen.length > SCROLLBACK) screen = screen.slice(-SCROLLBACK);
  emit({ type: "data", data });
}

/** Sends `watcher` the output so far, then everything after. Returns a function that stops it. */
export function watchTerminal(watcher: (event: TerminalEvent) => void) {
  watcher({ type: "reset", data: screen });
  watchers.add(watcher);
  return () => void watchers.delete(watcher);
}

/** Keys typed in the page's terminal. */
export function typeIntoComfy(data: string) {
  if (running(comfy)) comfy.pty.write(data);
}

export function resizeTerminal(cols: number, rows: number) {
  if (!(cols > 0 && rows > 0 && cols < 1000 && rows < 1000)) return;
  size = { cols: Math.floor(cols), rows: Math.floor(rows) };
  if (running(comfy)) comfy.pty.resize(size.cols, size.rows);
}

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

/** The folder's own Python when it has a venv, else python3 from the PATH. */
function pythonFor(folder: string) {
  for (const venv of ["venv", ".venv"]) {
    const python = join(folder, venv, "bin", "python");
    if (existsSync(python)) return python;
  }
  return "python3";
}

const running = (server: ComfyServer | null): server is ComfyServer => !!server && server.exitCode === null;

/** The last lines of output as plain text, for Settings → Services. */
function lastLines(count: number) {
  return screen
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-_]/g, "")
    .split("\n")
    // A progress bar redraws itself after a carriage return: keep what it last drew.
    .map((line) => line.split("\r").filter(Boolean).pop() ?? "")
    .filter((line) => line.trim())
    .slice(-count);
}

/** Starts ComfyUI from `folder`. Does nothing if it is already running from there. */
export async function startComfy(folderPath: string) {
  if (!folderPath.trim()) throw new Error("Pick the ComfyUI folder first.");
  const folder = resolve(expandHome(folderPath.trim()));
  if (!existsSync(join(folder, "main.py"))) throw new Error(`${folder} has no main.py. Pick the folder ComfyUI was cloned into.`);
  if (running(comfy)) {
    if (comfy.folder === folder) return comfy.ready;
    await stopComfy();
  }
  const port = await freePort();
  const python = pythonFor(folder);
  const args = ["main.py", "--listen", "127.0.0.1", "--port", String(port)];
  screen = "";
  emit({ type: "reset", data: "" });
  write(`\x1b[2m${folder}$ ${python} ${args.join(" ")}\x1b[0m\r\n`);
  // A pty starts its own session, so the process leads a group Stop and Hard restart can reach as a whole.
  let pty: IPty;
  try {
    pty = spawn(python, args, { name: "xterm-256color", cols: size.cols, rows: size.rows, cwd: folder, env: process.env as Record<string, string> });
  } catch (error) {
    write(`\x1b[31mCould not start ComfyUI: ${(error as Error).message}\x1b[0m\r\n`);
    throw new Error(`Could not start ComfyUI: ${(error as Error).message}`);
  }
  let exited!: () => void;
  const server: ComfyServer = {
    folder,
    port,
    pty,
    exited: new Promise((r) => (exited = r)),
    exitCode: null,
    ready: Promise.resolve(),
    startedAt: Date.now(),
    listening: false,
  };
  pty.onData(write);
  pty.onExit(({ exitCode, signal }) => {
    server.exitCode = exitCode;
    write(`\r\n\x1b[2m[ComfyUI exited${signal ? ` on signal ${signal}` : ` with code ${exitCode}`}]\x1b[0m\r\n`);
    exited();
  });
  const stopped = () => (server.exitCode === null ? undefined : new Error(`ComfyUI stopped (code ${server.exitCode}).\n${lastLines(15).join("\n")}`));
  server.ready = waitUntilAnswering(`http://127.0.0.1:${port}/system_stats`, START_TIMEOUT, stopped, "ComfyUI did not start in time.");
  comfy = server;
  try {
    await server.ready;
    server.listening = true;
  } catch (error) {
    if (comfy === server) comfy = null;
    signal(server, "SIGKILL");
    throw error;
  }
}

function signal(server: ComfyServer, name: NodeJS.Signals) {
  try {
    process.kill(-server.pty.pid, name);
  } catch {
    // Already gone.
  }
}

/** Asks ComfyUI to exit and waits for it, killing it if it takes longer than STOP_GRACE. `hard` kills it straight away. */
export async function stopComfy(hard = false) {
  const server = comfy;
  comfy = null;
  if (!running(server)) return;
  signal(server, hard ? "SIGKILL" : "SIGTERM");
  const timer = setTimeout(() => signal(server, "SIGKILL"), STOP_GRACE);
  await server.exited;
  clearTimeout(timer);
}

export async function restartComfy(folder: string, hard: boolean) {
  await stopComfy(hard);
  await startComfy(folder);
}

/** For the daemon's exit, which can't wait. */
export function killComfy() {
  if (running(comfy)) signal(comfy, "SIGKILL");
  comfy = null;
}

/** The port ComfyUI answers on, once it is up. */
export function comfyPort() {
  return running(comfy) && comfy.listening ? comfy.port : undefined;
}

/**
 * Joins the page's websocket under /api/comfy/ui/ to ComfyUI's. The request goes
 * on as it came, naming ComfyUI as its host and without the page's origin, which
 * ComfyUI refuses when it doesn't match the host.
 */
export function upgradeComfy(req: IncomingMessage, socket: Socket, head: Buffer) {
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  if (req.headers["sec-fetch-site"] === "cross-site") return refuse("403 Forbidden");
  const port = comfyPort();
  if (!port) return refuse("503 Service Unavailable");
  const path = (req.url ?? "/").slice("/api/comfy/ui".length);
  const upstream = connect(port, "127.0.0.1", () => {
    const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (!/^(host|origin)$/i.test(req.rawHeaders[i])) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

export function comfyStatus() {
  if (!running(comfy)) return { state: "stopped" as const };
  return {
    state: comfy.listening ? ("running" as const) : ("starting" as const),
    folder: comfy.folder,
    port: comfy.port,
    pid: comfy.pty.pid,
    startedAt: new Date(comfy.startedAt).toISOString(),
    log: lastLines(30),
  };
}

/** Whether a remote ComfyUI answers, and its version. */
export async function checkRemoteComfy(url: string) {
  const base = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return { ok: false, error: "Give the address with http:// or https://" };
  try {
    const res = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { ok: false, error: `It answered ${res.status}` };
    const stats = (await res.json()) as { system?: { comfyui_version?: string }; devices?: { name?: string }[] };
    return { ok: true, version: stats.system?.comfyui_version, device: stats.devices?.[0]?.name };
  } catch (error) {
    return { ok: false, error: `No answer: ${(error as Error).message}` };
  }
}
