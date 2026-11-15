// The voice server: speech/'s Python process, which runs Cascade and Haru.
// The daemon starts it on first use and keeps it running, like llama-server,
// and forwards the page's /api/voice/* to it, the session's websocket included:
//
//   /api/voice/<path>     →  its /api/<path>   (services, voices)
//   /api/voice/session    →  its /ws/session   (websocket)
import { spawn, type ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { connect, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, waitUntilAnswering } from "./net.ts";

const PROJECT = fileURLToPath(new URL("../speech", import.meta.url));
// The first start builds its Python environment, a few GB, so it gets a long time.
const START_TIMEOUT = 20 * 60_000;

interface VoiceServer {
  port: number;
  process: ChildProcess;
  log: string[];
  ready: Promise<void>;
  startedAt: number;
  /** Answering requests, rather than still starting. */
  listening: boolean;
}

let voice: VoiceServer | null = null;

function waitUntilListening(server: VoiceServer) {
  const stopped = () =>
    server.process.exitCode === null
      ? undefined
      : new Error(`The voice server stopped (code ${server.process.exitCode}).\n${server.log.slice(-15).join("\n")}`);
  return waitUntilAnswering(`http://127.0.0.1:${server.port}/api/services`, START_TIMEOUT, stopped, "The voice server did not start in time.");
}

/** The running voice server, started if it isn't. */
export async function ensureVoice(): Promise<VoiceServer> {
  if (voice && voice.process.exitCode === null) {
    await voice.ready;
    return voice;
  }
  const port = await freePort();
  const data = resolve(process.env.MODEL_HARNESS_DATA || "data", "voice");
  const child = spawn("uv", ["run", "--project", PROJECT, "--frozen", "speech-testing"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), SPEECH_TESTING_DATA: data },
  });
  const server: VoiceServer = { port, process: child, log: [], ready: Promise.resolve(), startedAt: Date.now(), listening: false };
  const collect = (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) console.log(`[voice] ${line}`);
    server.log.push(...lines);
    if (server.log.length > 200) server.log.splice(0, server.log.length - 200);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const spawnError = new Promise<never>((_, reject) =>
    child.on("error", (error) => reject(new Error(`Could not start the voice server with uv: ${error.message}. Install uv to use voice chats.`))),
  );
  server.ready = Promise.race([waitUntilListening(server), spawnError]);
  voice = server;
  try {
    await server.ready;
    server.listening = true;
  } catch (error) {
    if (voice === server) voice = null;
    child.kill("SIGTERM");
    throw error;
  }
  return server;
}

/** Whether the voice server is up, starting, or not running, with its last lines of output. */
export function voiceStatus() {
  if (!voice || voice.process.exitCode !== null) return { state: "stopped" as const };
  return {
    state: voice.listening ? ("running" as const) : ("starting" as const),
    port: voice.port,
    pid: voice.process.pid,
    startedAt: new Date(voice.startedAt).toISOString(),
    log: voice.log.slice(-30),
  };
}

export function stopVoice() {
  voice?.process.kill("SIGTERM");
  voice = null;
}

/** Where an HTTP request under /api/voice/ goes on the voice server. */
export function voiceTarget(server: VoiceServer, pathname: string, search: string) {
  return `http://127.0.0.1:${server.port}/api/${pathname.slice("/api/voice/".length)}${search}`;
}

/**
 * Joins the page's session websocket to the voice server's. The request goes on
 * as it came, naming the voice server as its host and without the page's origin,
 * which the voice server would refuse; the daemon has already turned away other sites.
 */
export async function upgradeVoice(req: IncomingMessage, socket: Socket, head: Buffer) {
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  if (req.headers["sec-fetch-site"] === "cross-site") return refuse("403 Forbidden");
  if (new URL(req.url ?? "/", "http://localhost").pathname !== "/api/voice/session") return refuse("404 Not Found");
  let server: VoiceServer;
  try {
    server = await ensureVoice();
  } catch {
    return refuse("503 Service Unavailable");
  }
  const upstream = connect(server.port, "127.0.0.1", () => {
    const lines = [`GET /ws/session HTTP/1.1`, `Host: 127.0.0.1:${server.port}`];
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
