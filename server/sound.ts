// Sound chats: the music and sound models in sound/, each a Python worker in an
// environment of its own that uv builds on first use. One runs at a time, so they
// never share the GPU with each other; picking another model stops the last one.
// Jobs wait their turn, and their audio is saved in data/sound/<chat id>/.
//
// The worker's protocol is in sound/pipe.py.
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = fileURLToPath(new URL("../sound", import.meta.url));
const DATA = resolve(process.env.MODEL_HARNESS_DATA || "data", "sound");
// The first start installs the libraries and downloads the weights, many GB.
const START_TIMEOUT = 60 * 60_000;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,80}\.(wav|flac)$/;

export type SoundMode = "song" | "instrumental" | "effect";

export interface SoundModel {
  id: string;
  name: string;
  detail: string;
  modes: SoundMode[];
  /** The longest it makes, in seconds. */
  longest: number;
}

export const SOUND_MODELS: SoundModel[] = [
  { id: "ace-step", name: "ACE-Step 1.5", detail: "Songs and instrumentals, up to 10 min", modes: ["song", "instrumental"], longest: 600 },
  { id: "yue", name: "YuE2", detail: "Songs from lyrics, slower, non-commercial", modes: ["song"], longest: 0 },
  { id: "effects", name: "Stable Audio Open", detail: "Effects and loops, up to 47 s", modes: ["effect"], longest: 47 },
];

export interface SoundRequest {
  chatId: string;
  model: string;
  mode: SoundMode;
  prompt: string;
  lyrics?: string;
  /** Seconds, or 0 to let the model choose. */
  seconds: number;
  takes: number;
  steps?: number;
  seed?: number;
  format: "wav" | "flac";
}

export interface Track {
  file: string;
  seconds: number;
  seed: number;
}

export type SoundEvent =
  | { type: "status"; text: string }
  | { type: "progress"; value: number }
  | { type: "done"; tracks: Track[] }
  | { type: "error"; message: string };

type Job = { id: number; onEvent: (event: SoundEvent) => void; finish: () => void };

interface Worker {
  model: string;
  process: ChildProcess;
  log: string[];
  startedAt: number;
  ready: Promise<void>;
  listening: boolean;
  jobs: Map<number, Job>;
  /** Told about loading progress while the worker starts. */
  onStatus?: (text: string) => void;
}

let worker: Worker | null = null;
let nextId = 0;
// Jobs run one after another, each waiting for the last.
let queue: Promise<void> = Promise.resolve();

function remember(w: Worker, lines: string[]) {
  for (const line of lines) console.log(`[sound] ${line}`);
  w.log.push(...lines);
  if (w.log.length > 200) w.log.splice(0, w.log.length - 200);
}

function startWorker(model: string): Worker {
  const home = join(HOME, model);
  const env: NodeJS.ProcessEnv = { ...process.env, TQDM_DISABLE: "1" };
  delete env.VIRTUAL_ENV;
  const child = spawn("uv", ["run", "--project", home, "python", join(home, "worker.py")], { stdio: ["pipe", "pipe", "pipe"], env });
  const w: Worker = { model, process: child, log: [], startedAt: Date.now(), ready: Promise.resolve(), listening: false, jobs: new Map() };
  child.stderr?.on("data", (chunk: Buffer) => remember(w, chunk.toString().split("\n").filter(Boolean)));

  let becameReady!: () => void;
  let failed!: (error: Error) => void;
  w.ready = new Promise<void>((resolve, reject) => ((becameReady = resolve), (failed = reject)));
  const timer = setTimeout(() => failed(new Error("The sound model did not start in time.")), START_TIMEOUT);

  createInterface({ input: child.stdout! }).on("line", (line) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return remember(w, [line]);
    }
    const job = w.jobs.get(event.id as number);
    switch (event.event) {
      case "status":
        remember(w, [String(event.text)]);
        w.onStatus?.(String(event.text));
        return;
      case "ready":
        clearTimeout(timer);
        w.listening = true;
        becameReady();
        return;
      case "progress":
        return job?.onEvent({ type: "progress", value: Number(event.value) });
      case "done":
        job?.onEvent({ type: "done", tracks: event.tracks as Track[] });
        return job?.finish();
      case "error":
        job?.onEvent({ type: "error", message: String(event.message) });
        return job?.finish();
    }
  });

  child.on("error", (error) => failed(new Error(`Could not start the sound model with uv: ${error.message}. Install uv to use sound chats.`)));
  child.on("exit", (code) => {
    clearTimeout(timer);
    failed(new Error(`The sound model stopped (code ${code}).\n${w.log.slice(-15).join("\n")}`));
    for (const job of w.jobs.values()) {
      job.onEvent({ type: "error", message: `The sound model stopped (code ${code}). Settings → Services shows its last output.` });
      job.finish();
    }
    w.jobs.clear();
    if (worker === w) worker = null;
  });
  return w;
}

/** The worker for `model`, started if it isn't, after stopping any other. */
async function ensureWorker(model: string, onStatus: (text: string) => void): Promise<Worker> {
  if (worker && worker.model !== model) stopSound();
  if (!worker) {
    onStatus("Starting the model. The first time, it downloads its libraries and weights, which takes a while.");
    worker = startWorker(model);
  }
  const w = worker;
  w.onStatus = onStatus;
  try {
    await w.ready;
  } catch (error) {
    if (worker === w) stopSound();
    throw error;
  } finally {
    w.onStatus = undefined;
  }
  return w;
}

/** Makes the sounds `request` asks for, telling `onEvent` how it's going. Resolves when it's done. */
export function makeSound(request: SoundRequest, onEvent: (event: SoundEvent) => void): Promise<void> {
  const run = async () => {
    const id = nextId++;
    const folder = join(DATA, request.chatId);
    await mkdir(folder, { recursive: true });
    let w: Worker;
    try {
      w = await ensureWorker(request.model, (text) => onEvent({ type: "status", text }));
    } catch (error) {
      return onEvent({ type: "error", message: (error as Error).message });
    }
    onEvent({ type: "status", text: "Making" });
    await new Promise<void>((finish) => {
      w.jobs.set(id, { id, onEvent, finish: () => (w.jobs.delete(id), finish()) });
      w.process.stdin?.write(`${JSON.stringify({
        op: "make",
        id,
        mode: request.mode,
        prompt: request.prompt,
        lyrics: request.lyrics ?? "",
        seconds: request.seconds,
        takes: request.takes,
        steps: request.steps,
        seed: request.seed,
        format: request.format,
        folder,
        name: `${Date.now().toString(36)}-${id}`,
      })}\n`);
    });
  };
  const turn = queue.then(run, run);
  queue = turn.catch(() => {});
  return turn;
}

/** POST /api/sound/make: the request as JSON, answered with one JSON event per line. */
export async function handleMake(body: Partial<SoundRequest>, res: ServerResponse) {
  const model = SOUND_MODELS.find((m) => m.id === body.model);
  if (!model) return void res.writeHead(400).end(JSON.stringify({ error: "Unknown sound model" }));
  if (!body.chatId || !/^[A-Za-z0-9_-]{1,64}$/.test(body.chatId)) return void res.writeHead(400).end(JSON.stringify({ error: "Bad chat id" }));
  const request: SoundRequest = {
    chatId: body.chatId,
    model: model.id,
    mode: model.modes.includes(body.mode as SoundMode) ? (body.mode as SoundMode) : model.modes[0],
    prompt: String(body.prompt ?? "").slice(0, 2000),
    lyrics: String(body.lyrics ?? "").slice(0, 8000),
    seconds: Math.min(Math.max(Number(body.seconds) || 0, 0), model.longest),
    takes: Math.min(Math.max(Math.round(Number(body.takes) || 1), 1), 4),
    steps: Number(body.steps) || undefined,
    seed: Number.isInteger(body.seed) ? body.seed : undefined,
    format: body.format === "flac" ? "flac" : "wav",
  };
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  // A page that leaves stops hearing about the job, but it still finishes and is saved.
  await makeSound(request, (event) => res.writableEnded || res.write(`${JSON.stringify(event)}\n`));
  res.end();
}

/** GET /api/sound/files/<chat id>/<name>: a saved track, with ranges so the player can seek. */
export async function serveSound(req: IncomingMessage, res: ServerResponse, path: string) {
  const [chatId, name] = path.split("/");
  if (!chatId || !/^[A-Za-z0-9_-]{1,64}$/.test(chatId) || !name || !SAFE_NAME.test(name)) return void res.writeHead(400).end();
  const file = join(DATA, chatId, name);
  const info = await stat(file).catch(() => null);
  if (!info) return void res.writeHead(404).end();
  const type = name.endsWith(".flac") ? "audio/flac" : "audio/wav";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  const headers = { "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=31536000, immutable" };
  if (!range) {
    res.writeHead(200, { ...headers, "content-length": info.size });
    return void createReadStream(file).pipe(res);
  }
  const start = range[1] ? Number(range[1]) : info.size - Number(range[2]);
  const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
  if (start > end || start < 0) return void res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
  res.writeHead(206, { ...headers, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${info.size}` });
  createReadStream(file, { start, end }).pipe(res);
}

/** A deleted chat's audio goes with it. */
export function deleteChatSounds(chatId: string) {
  return rm(join(DATA, chatId), { recursive: true, force: true });
}

/** Whether a sound model is loaded, which, and its last lines of output. */
export function soundStatus() {
  if (!worker || worker.process.exitCode !== null) return { state: "stopped" as const };
  return {
    state: worker.listening ? ("running" as const) : ("starting" as const),
    model: SOUND_MODELS.find((m) => m.id === worker!.model)?.name ?? worker.model,
    pid: worker.process.pid!,
    startedAt: new Date(worker.startedAt).toISOString(),
    busy: worker.jobs.size > 0,
    log: worker.log.slice(-30),
  };
}

/** Ends the worker, giving its GPU memory back. Closing stdin lets it exit; it's killed if it doesn't. */
export function stopSound() {
  const w = worker;
  if (!w) return;
  worker = null;
  w.process.stdin?.end();
  setTimeout(() => w.process.exitCode === null && w.process.kill("SIGKILL"), 10_000).unref();
}
