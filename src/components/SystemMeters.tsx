import { useEffect, useState } from "react";
import { errorText } from "../lib/http";
import { AlertIcon, CheckIcon, TrashIcon, XIcon } from "./Icons";

interface SystemStats {
  ram: { used: number; total: number };
  gpus: { name: string; utilization: number; memoryUsed: number; memoryTotal: number }[];
}

const POLL_MS = 2000;
const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

function useSystemStats() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch("/api/system");
          if (res.ok && !stopped) setStats(await res.json());
        } catch {
          // Dev server restarting; try again next tick.
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);
  return stats;
}

function Meter({ label, value, title }: { label: string; value: number; title: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const level = percent >= 95 ? "is-critical" : percent >= 85 ? "is-high" : "";
  return (
    <div className={`meter ${level}`} title={title} role="meter" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className="meter-fill" style={{ transform: `scaleX(${percent / 100})` }} />
      </span>
      <span className="meter-value">{percent}%</span>
    </div>
  );
}

type FreeResult = { state: "idle" } | { state: "running" } | { state: "done" } | { state: "error"; message: string; rule?: string };

/** A trash button beside a meter. Unloads the local model, or also drops the OS caches. */
function FreeButton({ path, label, onError }: { path: string; label: string; onError: (e: { message: string; rule?: string }) => void }) {
  const [result, setResult] = useState<FreeResult>({ state: "idle" });

  useEffect(() => {
    if (result.state !== "done") return;
    const timer = window.setTimeout(() => setResult({ state: "idle" }), 1500);
    return () => window.clearTimeout(timer);
  }, [result]);

  const run = async () => {
    setResult({ state: "running" });
    try {
      const res = await fetch(path, { method: "POST" });
      if (!res.ok) throw new Error(await errorText(res));
      const json = await res.json();
      if (json.sudoRule) {
        const error = { message: "Model unloaded. Dropping OS caches needs this sudo rule, added with sudo visudo:", rule: json.sudoRule };
        setResult({ state: "error", ...error });
        onError(error);
      } else {
        setResult({ state: "done" });
      }
    } catch (e) {
      const error = { message: (e as Error).message };
      setResult({ state: "error", ...error });
      onError(error);
    }
  };

  return (
    <button
      type="button"
      className={`meter-free ${result.state === "done" ? "is-done" : ""}`}
      aria-label={label}
      title={label}
      disabled={result.state === "running"}
      onClick={run}
    >
      {result.state === "done" ? <CheckIcon size={13} /> : <TrashIcon size={13} />}
    </button>
  );
}

/** GPU load, VRAM and system RAM, refreshed every couple of seconds. */
export function SystemMeters() {
  const stats = useSystemStats();
  const [error, setError] = useState<{ message: string; rule?: string } | null>(null);
  if (!stats) return null;
  const gpu = stats.gpus[0];
  return (
    <div className="meters">
      {gpu && (
        <>
          <Meter label="GPU" value={gpu.utilization / 100} title={`${gpu.name}: ${gpu.utilization}% busy`} />
          <Meter
            label="VRAM"
            value={gpu.memoryUsed / gpu.memoryTotal}
            title={`${gpu.name}: ${gb(gpu.memoryUsed)} of ${gb(gpu.memoryTotal)} GB used`}
          />
          <FreeButton path="/api/local/stop" label="Unload model" onError={setError} />
        </>
      )}
      <Meter label="RAM" value={stats.ram.used / stats.ram.total} title={`${gb(stats.ram.used)} of ${gb(stats.ram.total)} GB used`} />
      <FreeButton path="/api/system/free" label="Unload model and free up RAM" onError={setError} />
      {error && (
        <div className="meter-error" role="alert">
          <AlertIcon size={15} />
          <span>{error.message}{error.rule && <><br /><code>{error.rule}</code></>}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setError(null)}><XIcon size={14} /></button>
        </div>
      )}
    </div>
  );
}
