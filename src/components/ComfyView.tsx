import { useEffect, useState } from "react";
import { updateComfy, useStore } from "../state/store";
import { errorText } from "../lib/http";
import { AlertIcon, CheckIcon, FolderIcon, PlayIcon, RefreshIcon, StopIcon } from "./Icons";
import { FolderPicker } from "./FolderPicker";
import { Field } from "./Field";
import { Segmented } from "./Segmented";
import { uptime } from "./ServicesView";
import { ComfyTerminal } from "./ComfyTerminal";
import { ComfyFrame } from "./ComfyFrame";

// Settings → ComfyUI: run it from a folder on this machine, or point at one running elsewhere.

type LocalStatus =
  | { state: "stopped" }
  | { state: "starting" | "running"; folder: string; port: number; pid: number; startedAt: string };

type Check = { state: "idle" } | { state: "running" } | { state: "ok"; version?: string; device?: string } | { state: "error"; message: string };

const MODES = [
  { value: "local", label: "Local", title: "Run ComfyUI from a folder on this machine." },
  { value: "remote", label: "Network", title: "Connect to a ComfyUI running on another machine." },
] as const;

const POLL_MS = 2000;

type Action = "start" | "restart" | "hard" | "stop";
const STATE = { running: "Running", starting: "Starting", stopped: "Stopped" } as const;
const BUSY: Record<Action, string> = { start: "Starting", restart: "Restarting", hard: "Restarting", stop: "Stopping" };

function LocalComfy() {
  const folder = useStore((s) => s.comfy.folder);
  const [browsing, setBrowsing] = useState(false);
  const [status, setStatus] = useState<LocalStatus>({ state: "stopped" });
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(false);

  const refresh = async () => {
    try {
      const res = await fetch("/api/comfy/status");
      if (res.ok) setStatus(await res.json());
    } catch {
      // The daemon is restarting; the next poll catches up.
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const run = async (action: Action) => {
    setBusy(action);
    setError("");
    const path = action === "hard" ? "/api/comfy/restart?hard" : `/api/comfy/${action}`;
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folder }) });
      if (!res.ok) throw new Error(await errorText(res));
      setStatus(await res.json());
    } catch (e) {
      setError((e as Error).message.replace(/^\d+: /, ""));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const stopped = status.state === "stopped";
  // Running from a folder other than the one picked: Restart moves it over.
  const otherFolder = !stopped && folder && status.folder !== folder;

  return (
    <>
      <Field label="ComfyUI folder" hint="The folder ComfyUI was cloned into, with its main.py. It runs with that folder's venv when it has one, else python3.">
        <div className="folder-input">
          <input placeholder="~/ComfyUI" value={folder} spellCheck={false} onChange={(e) => updateComfy({ folder: e.target.value })} />
          <button type="button" className="icon-button" aria-label="Browse for a folder" title="Browse" onClick={() => setBrowsing(true)}>
            <FolderIcon size={16} />
          </button>
        </div>
        {browsing && (
          <FolderPicker
            initial={folder}
            onClose={() => setBrowsing(false)}
            onPick={(path) => {
              updateComfy({ folder: path });
              setBrowsing(false);
            }}
          />
        )}
      </Field>
      <div className="setting-row">
        <div className="comfy-status">
          <span className={`service-dot is-${status.state}`} role="img" aria-label={STATE[status.state]} title={STATE[status.state]} />
          {status.state !== "stopped" && (
            <span className="comfy-details">
              {[`Port ${status.port}`, `PID ${status.pid}`, `Up ${uptime(status.startedAt)}`].join(" - ")}
              {status.state === "running" && (
                <button type="button" className="comfy-open" onClick={() => setViewing(true)}>Open ComfyUI</button>
              )}
            </span>
          )}
        </div>
        <div className="segmented is-actions">
          <button type="button" className={busy === "start" ? "is-active" : ""} disabled={!!busy || !stopped || !folder.trim()} onClick={() => void run("start")}>
            <PlayIcon size={13} />
            {busy === "start" ? BUSY.start : "Start"}
          </button>
          <button
            type="button"
            className={busy === "restart" ? "is-active" : ""}
            title="Asks ComfyUI to exit, then starts it again."
            disabled={!!busy || stopped}
            onClick={() => void run("restart")}
          >
            <RefreshIcon size={13} />
            {busy === "restart" ? BUSY.restart : "Restart"}
          </button>
          <button
            type="button"
            className={busy === "hard" ? "is-active" : ""}
            title="Kills ComfyUI straight away, then starts it again. For when it's stuck."
            disabled={!!busy || stopped}
            onClick={() => void run("hard")}
          >
            <RefreshIcon size={13} />
            {busy === "hard" ? BUSY.hard : "Hard restart"}
          </button>
          <button type="button" className={busy === "stop" ? "is-active" : ""} disabled={!!busy || stopped} onClick={() => void run("stop")}>
            <StopIcon size={13} />
            {busy === "stop" ? BUSY.stop : "Stop"}
          </button>
        </div>
      </div>
      {error && <p className="test-result is-error"><AlertIcon size={15} />{error}</p>}
      {otherFolder && <p className="service-note">Running from a different folder. Restart to use the one picked above.</p>}
      <ComfyTerminal />
      {viewing && status.state === "running" && <ComfyFrame url="/api/comfy/ui/" onClose={() => setViewing(false)} />}
    </>
  );
}

function RemoteComfy() {
  const url = useStore((s) => s.comfy.url);
  const [check, setCheck] = useState<Check>({ state: "idle" });
  const [viewing, setViewing] = useState(false);
  const address = url.trim().replace(/\/+$/, "");

  const test = async () => {
    setCheck({ state: "running" });
    try {
      const res = await fetch(`/api/comfy/check?url=${encodeURIComponent(url)}`);
      if (!res.ok) throw new Error(await errorText(res));
      const result: { ok: boolean; version?: string; device?: string; error?: string } = await res.json();
      setCheck(result.ok ? { state: "ok", version: result.version, device: result.device } : { state: "error", message: result.error ?? "No answer" });
    } catch (e) {
      setCheck({ state: "error", message: (e as Error).message });
    }
  };

  return (
    <>
      <Field label="Address" hint="Where the other machine's ComfyUI answers. Start it there with --listen so it accepts connections from the network.">
        <input
          placeholder="http://192.168.1.20:8188"
          value={url}
          spellCheck={false}
          onChange={(e) => {
            updateComfy({ url: e.target.value });
            setCheck({ state: "idle" });
          }}
        />
      </Field>
      <div className="provider-actions">
        <button className="button" onClick={() => void test()} disabled={check.state === "running" || !url.trim()}>
          {check.state === "running" ? "Testing" : "Test connection"}
        </button>
        <button className="button" onClick={() => setViewing(true)} disabled={!/^https?:\/\/./.test(address)}>
          Open ComfyUI
        </button>
      </div>
      {viewing && <ComfyFrame url={address} onClose={() => setViewing(false)} />}
      {check.state === "ok" && (
        <p className="test-result is-ok">
          <CheckIcon size={15} />
          Connected.{check.version && ` ComfyUI ${check.version}`}{check.device && ` on ${check.device}`}
        </p>
      )}
      {check.state === "error" && <p className="test-result is-error"><AlertIcon size={15} />{check.message}</p>}
      <p className="muted">This app can't start or stop a ComfyUI on another machine. Run those from that machine.</p>
    </>
  );
}

export function ComfyView() {
  const mode = useStore((s) => s.comfy.mode);
  return (
    <div className="general-settings comfy-settings">
      <div className="setting-row">
        <span>ComfyUI runs</span>
        <Segmented label="ComfyUI runs" options={MODES} value={mode} onChange={(m) => updateComfy({ mode: m })} />
      </div>
      {mode === "local" ? <LocalComfy /> : <RemoteComfy />}
    </div>
  );
}
