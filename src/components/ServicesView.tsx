import { useEffect, useState, type ReactNode } from "react";
import { useStore } from "../state/store";
import { errorText } from "../lib/http";
import { stopVoiceServer } from "../voice/client";
import { stopSoundServer } from "../sound/client";

// Settings → Services: what the app has running, from the daemon's /api/status.

interface Status {
  app: { startedAt: string; pagePort?: number; apiPort: number; unloadedChanges: string[] };
  daemon: { pid: number; startedAt: string; unloadedChanges: string[] };
  piRuns: { chat: string; startedAt: string }[];
  llamaServer:
    | { running: false }
    | { running: true; model: string; port: number; pid: number; contextWindow?: number; startedAt: string; gpuMemory?: number; log?: string[] };
  voiceServer:
    | { state: "stopped" }
    | { state: "starting" | "running"; port: number; pid: number; startedAt: string; gpuMemory?: number; log?: string[] };
  soundServer:
    | { state: "stopped" }
    | { state: "starting" | "running"; model: string; pid: number; startedAt: string; busy: boolean; gpuMemory?: number; log?: string[] };
  comfy:
    | { state: "stopped" }
    | { state: "starting" | "running"; folder: string; port: number; pid: number; startedAt: string; gpuMemory?: number; log?: string[] };
  restartPending: string | null;
}

const POLL_MS = 2000;

export function uptime(since: string) {
  const minutes = Math.floor((Date.now() - Date.parse(since)) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** One process: a dot for its state, its name, what it's doing, and its recent output. */
export function Service({ name, state, details, action, log, note }: {
  name: string;
  state: "running" | "starting" | "stopped";
  details: (string | false | 0 | undefined)[];
  action?: ReactNode;
  log?: string[];
  note?: string;
}) {
  return (
    <div className="service">
      <div className="service-head">
        <span className={`service-dot is-${state}`} aria-hidden="true" />
        <strong>{name}</strong>
        <span className="service-state">{state === "running" ? "Running" : state === "starting" ? "Starting" : "Stopped"}</span>
        {action}
      </div>
      {details.some(Boolean) && <p className="service-details">{details.filter(Boolean).join(" - ")}</p>}
      {note && <p className="service-note">{note}</p>}
      {log && log.length > 0 && (
        <details className="service-log">
          <summary>Recent output</summary>
          <pre>{log.join("\n")}</pre>
        </details>
      )}
    </div>
  );
}

function StopButton({ onStop }: { onStop: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="segmented is-actions service-action">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onStop().finally(() => setBusy(false));
        }}
      >
        {busy ? "Stopping" : "Stop"}
      </button>
    </div>
  );
}

const restartNote = (files: string[]) => (files.length ? `Changed since it started: ${files.join(", ")}. A restart loads them.` : undefined);

export function ServicesView() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const chats = useStore((s) => s.conversations);

  const refresh = async () => {
    try {
      const res = await fetch("/api/status?detail");
      if (!res.ok) throw new Error(await errorText(res));
      setStatus(await res.json());
      setError("");
    } catch (e) {
      setError(`The daemon didn't answer: ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const stopLlama = async () => {
    await fetch("/api/local/stop", { method: "POST" });
    await refresh();
  };
  const stopVoice = async () => {
    await stopVoiceServer();
    await refresh();
  };

  const stopSound = async () => {
    await stopSoundServer();
    await refresh();
  };

  const stopComfy = async () => {
    await fetch("/api/comfy/stop", { method: "POST" });
    await refresh();
  };

  if (!status) return <div className="general-settings">{error && <p className="service-note">{error}</p>}</div>;
  const { app, daemon, llamaServer: llama, voiceServer: voice, soundServer: sound, piRuns } = status;
  // A daemon started before ComfyUI was added sends no comfy field.
  const comfy = status.comfy ?? { state: "stopped" as const };
  const title = (id: string) => chats.find((c) => c.id === id)?.title ?? id;

  return (
    <div className="general-settings service-list">
      {error && <p className="service-note">{error}</p>}
      <Service
        name="App"
        state="running"
        details={[app.pagePort && `Port ${app.pagePort}`, `Up ${uptime(app.startedAt)}`]}
        note={restartNote(app.unloadedChanges)}
      />
      <Service
        name="Daemon"
        state="running"
        details={[`Port ${app.apiPort}`, `PID ${daemon.pid}`, `Up ${uptime(daemon.startedAt)}`]}
        note={restartNote(daemon.unloadedChanges)}
      />
      <Service
        name="llama-server"
        state={llama.running ? "running" : "stopped"}
        details={
          llama.running
            ? [
                llama.model,
                llama.contextWindow && `${llama.contextWindow.toLocaleString()} context`,
                llama.gpuMemory ? `${gigabytes(llama.gpuMemory)} GPU` : undefined,
                `Port ${llama.port}`,
                `PID ${llama.pid}`,
                `Up ${uptime(llama.startedAt)}`,
              ]
            : ["Starts with the next message to a local model"]
        }
        action={llama.running && <StopButton onStop={stopLlama} />}
        log={llama.running ? llama.log : undefined}
      />
      <Service
        name="Voice server"
        state={voice.state}
        details={
          voice.state === "stopped"
            ? ["Starts with the next voice chat"]
            : [
                voice.gpuMemory ? `${gigabytes(voice.gpuMemory)} GPU` : undefined,
                `Port ${voice.port}`,
                `PID ${voice.pid}`,
                `Up ${uptime(voice.startedAt)}`,
              ]
        }
        action={voice.state !== "stopped" && <StopButton onStop={stopVoice} />}
        log={voice.state === "stopped" ? undefined : voice.log}
      />
      <Service
        name="Sound model"
        state={sound.state}
        details={
          sound.state === "stopped"
            ? ["Starts with the next sound chat request"]
            : [
                sound.model,
                sound.busy && "Making",
                sound.gpuMemory ? `${gigabytes(sound.gpuMemory)} GPU` : undefined,
                `PID ${sound.pid}`,
                `Up ${uptime(sound.startedAt)}`,
              ]
        }
        action={sound.state !== "stopped" && <StopButton onStop={stopSound} />}
        log={sound.state === "stopped" ? undefined : sound.log}
      />
      <Service
        name="ComfyUI"
        state={comfy.state}
        details={
          comfy.state === "stopped"
            ? ["Starts from Settings → ComfyUI"]
            : [
                comfy.gpuMemory ? `${gigabytes(comfy.gpuMemory)} GPU` : undefined,
                `Port ${comfy.port}`,
                `PID ${comfy.pid}`,
                `Up ${uptime(comfy.startedAt)}`,
              ]
        }
        action={comfy.state !== "stopped" && <StopButton onStop={stopComfy} />}
        log={comfy.state === "stopped" ? undefined : comfy.log}
      />
      <Service
        name="pi"
        state={piRuns.length ? "running" : "stopped"}
        details={
          piRuns.length
            ? piRuns.map((r) => `${title(r.chat)} (${uptime(r.startedAt)})`)
            : ["Runs while a chat with the pi harness replies"]
        }
      />
    </div>
  );
}
