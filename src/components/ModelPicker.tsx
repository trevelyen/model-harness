import { useEffect, useMemo, useRef, useState } from "react";
import { getModelAdapter } from "../adapters/registry";
import type { ModelInfo } from "../adapters/types";
import { getState, setState, useStore, type Provider } from "../state/store";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "./Icons";
import { ProgressRing } from "./ProgressRing";

type Listing = { state: "loading" } | { state: "ok"; models: ModelInfo[] } | { state: "error"; message: string };

const POLL_MS = 1500;

/** Bytes per second for each downloading model, smoothed across polls. */
function useRates() {
  const samples = useRef(new Map<string, { bytes: number; time: number; rate?: number }>());
  return (models: ModelInfo[]) => {
    const now = performance.now();
    for (const m of models) {
      if (!m.download) {
        samples.current.delete(m.id);
        continue;
      }
      const prev = samples.current.get(m.id);
      let rate = prev?.rate;
      if (prev && now > prev.time && m.download.received > prev.bytes) {
        const instant = ((m.download.received - prev.bytes) * 1000) / (now - prev.time);
        rate = rate === undefined ? instant : rate * 0.6 + instant * 0.4;
      } else if (prev && m.download.received === prev.bytes) {
        rate = undefined;
      }
      samples.current.set(m.id, { bytes: m.download.received, time: now, rate });
    }
    return (id: string) => samples.current.get(id)?.rate;
  };
}

function useListings(providers: Provider[], open: boolean) {
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [rates, setRates] = useState<(id: string) => number | undefined>(() => () => undefined);
  const track = useRates();
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const inflight = new Set<string>();
    const load = (p: Provider) => {
      const adapter = getModelAdapter(p.adapter);
      if (!adapter || inflight.has(p.id)) return;
      inflight.add(p.id);
      adapter
        .listModels(p.settings, controller.signal)
        .then((models) => {
          const rateOf = track(models);
          setRates(() => rateOf);
          setListings((l) => ({ ...l, [p.id]: { state: "ok", models } }));
        })
        .catch((e: Error) => {
          if (!controller.signal.aborted) setListings((l) => ({ ...l, [p.id]: { state: "error", message: e.message } }));
        })
        .finally(() => inflight.delete(p.id));
    };
    for (const p of providers) {
      setListings((l) => ({ ...l, [p.id]: l[p.id]?.state === "ok" ? l[p.id] : { state: "loading" } }));
      load(p);
    }
    const live = providers.filter((p) => getModelAdapter(p.adapter)?.live);
    const timer = live.length ? window.setInterval(() => live.forEach(load), POLL_MS) : undefined;
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [providers, open]);
  return { listings, rates };
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

function formatEta(seconds: number) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

function DownloadRow({ model, rate }: { model: ModelInfo; rate?: number }) {
  const { received, total, active } = model.download!;
  const fraction = total ? received / total : undefined;
  const parts = [total ? `${gb(received)} of ${gb(total)}` : `${gb(received)} so far`];
  if (active && rate) parts.push(`${(rate / 1e6).toFixed(0)} MB/s`);
  if (active && rate && total) parts.push(formatEta((total - received) / rate));
  if (!active) parts.push("paused");
  return (
    <div className="picker-item is-downloading" title={active ? "Downloading" : "Download stopped partway"}>
      <ProgressRing value={fraction} paused={!active} />
      <span className="picker-item-text">
        <span className="picker-item-name">{model.label ?? model.id}</span>
        <span className="picker-item-sub">{parts.join(", ")}</span>
      </span>
      {fraction !== undefined && <span className="picker-item-detail">{Math.floor(fraction * 100)}%</span>}
    </div>
  );
}

/** Refreshes the selected model's thinking support from its provider on load. */
function useSyncSelection() {
  const providerId = useStore((s) => s.selection?.providerId);
  const model = useStore((s) => s.selection?.model);
  useEffect(() => {
    const provider = getState().providers.find((p) => p.id === providerId);
    const adapter = provider && getModelAdapter(provider.adapter);
    if (!provider || !adapter || !model) return;
    const controller = new AbortController();
    adapter
      .listModels(provider.settings, controller.signal)
      .then((models) => {
        const found = models.find((m) => m.id === model);
        if (!found) return;
        setState((s) =>
          s.selection?.model === model && JSON.stringify(s.selection.reasoning) !== JSON.stringify(found.reasoning)
            ? { ...s, selection: { ...s.selection, reasoning: found.reasoning } }
            : s,
        );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [providerId, model]);
}

export function ModelPicker() {
  useSyncSelection();
  const providers = useStore((s) => s.providers);
  const selection = useStore((s) => s.selection);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { listings, rates } = useListings(providers, open);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(
    () =>
      providers.map((p) => {
        const listing = listings[p.id];
        const models = listing?.state === "ok"
          ? listing.models.filter((m) => !q || (m.label ?? m.id).toLowerCase().includes(q))
          : [];
        return { provider: p, listing, models };
      }),
    [providers, listings, q],
  );

  const choose = (provider: Provider, model: ModelInfo) => {
    setState((s) => ({
      ...s,
      selection: { providerId: provider.id, model: model.id, label: model.label ?? model.id, reasoning: model.reasoning },
    }));
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="picker" ref={ref}>
      <button className={`picker-trigger ${open ? "is-open" : ""}`} onClick={() => setOpen((o) => !o)}>
        <span className="picker-label">{selection?.label ?? "Choose a model"}</span>
        <ChevronDownIcon size={16} />
      </button>
      {open && (
        <div className="picker-menu" role="listbox">
          <label className="picker-search">
            <SearchIcon size={15} />
            <input autoFocus placeholder="Search models" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="picker-scroll">
            {sections.every(({ listing }) => listing?.state === "error") && (
              <div className="picker-note">No providers are reachable. Check them in Settings.</div>
            )}
            {/* Providers that cannot be reached are hidden; Settings shows why. */}
            {sections.filter(({ listing }) => listing?.state !== "error").map(({ provider, listing, models }) => (
              <section key={provider.id}>
                <h4>{provider.name}</h4>
                {(!listing || listing.state === "loading") && <div className="picker-note shimmer">Looking for models</div>}
                {listing?.state === "ok" && models.length === 0 && <div className="picker-note">{q ? "No matches" : "No models found"}</div>}
                {models.map((m) => {
                  if (m.download) return <DownloadRow key={m.id} model={m} rate={rates(m.id)} />;
                  const active = selection?.providerId === provider.id && selection.model === m.id;
                  return (
                    <button key={m.id} className={`picker-item ${active ? "is-active" : ""}`} onClick={() => choose(provider, m)}>
                      <span className="picker-item-name">{m.label ?? m.id}</span>
                      {m.detail && <span className="picker-item-detail">{m.detail}</span>}
                      {active && <CheckIcon size={15} />}
                    </button>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
