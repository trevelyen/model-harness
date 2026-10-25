import { useEffect, useState } from "react";

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

/** GPU load, VRAM and system RAM, refreshed every couple of seconds. */
export function SystemMeters() {
  const stats = useSystemStats();
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
        </>
      )}
      <Meter label="RAM" value={stats.ram.used / stats.ram.total} title={`${gb(stats.ram.used)} of ${gb(stats.ram.total)} GB used`} />
    </div>
  );
}
