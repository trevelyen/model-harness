import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getModelAdapter, modelAdapters } from "../adapters/registry";
import { saveNow, setState, uid, useStore, type Provider } from "../state/store";
import { errorText } from "../lib/http";
import { CheckIcon, PlusIcon, RefreshIcon, ServerIcon, SettingsIcon, TrashIcon, XIcon, AlertIcon } from "./Icons";

type Test = { state: "idle" } | { state: "running" } | { state: "ok"; count: number } | { state: "error"; message: string };

function ProviderEditor({ provider }: { provider: Provider }) {
  const adapter = getModelAdapter(provider.adapter);
  const [test, setTest] = useState<Test>({ state: "idle" });
  if (!adapter) return null;

  const update = (patch: Partial<Provider>) =>
    setState((s) => ({ ...s, providers: s.providers.map((p) => (p.id === provider.id ? { ...p, ...patch } : p)) }));

  const run = async () => {
    setTest({ state: "running" });
    try {
      const models = await adapter.listModels(provider.settings);
      setTest({ state: "ok", count: models.length });
    } catch (e) {
      setTest({ state: "error", message: (e as Error).message });
    }
  };

  const remove = () =>
    setState((s) => ({
      ...s,
      providers: s.providers.filter((p) => p.id !== provider.id),
      selection: s.selection?.providerId === provider.id ? null : s.selection,
    }));

  return (
    <div className="provider-editor" key={provider.id}>
      <div className="field">
        <label>Name</label>
        <input value={provider.name} onChange={(e) => update({ name: e.target.value })} />
      </div>
      <p className="adapter-note"><strong>{adapter.label}.</strong> {adapter.description}</p>
      {adapter.fields.map((f) => (
        <div className="field" key={f.key}>
          <label>{f.label}</label>
          <input
            type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
            placeholder={f.placeholder}
            value={provider.settings[f.key] ?? ""}
            onChange={(e) => update({ settings: { ...provider.settings, [f.key]: e.target.value } })}
          />
          {f.help && <small>{f.help}</small>}
        </div>
      ))}
      <div className="provider-actions">
        <button className="button" onClick={run} disabled={test.state === "running"}>
          {test.state === "running" ? "Testing" : "Test connection"}
        </button>
        <button className="button is-ghost is-danger" onClick={remove}>
          <TrashIcon size={15} />
          Remove
        </button>
      </div>
      {test.state === "ok" && <p className="test-result is-ok"><CheckIcon size={15} />Connected. {test.count} models found.</p>}
      {test.state === "error" && <p className="test-result is-error"><AlertIcon size={15} />{test.message}</p>}
    </div>
  );
}

const BAR_SCALES = [
  { value: "limit", label: "Limit", title: "The full bar is your context size limit." },
  { value: "model", label: "Max", title: "The full bar is the most the model can handle. Your limit shows as a lighter section." },
] as const;

/** Chooses what the composer's context bar measures against. */
function ContextBarChoice() {
  const scale = useStore((s) => s.contextBar);
  return (
    <div className="setting-row">
      <span>Context bar shows</span>
      <div className="segmented" role="radiogroup" aria-label="Context bar shows">
        {BAR_SCALES.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={scale === o.value}
            className={scale === o.value ? "is-active" : ""}
            title={o.title}
            onClick={() => setState((s) => ({ ...s, contextBar: o.value }))}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Whether saved code reaches the page straight away, or on the next restart. */
function HotReloadChoice() {
  const on = useStore((s) => s.hotReload);
  return (
    <div className="setting-row">
      <span>Hot reload</span>
      <div className="segmented" role="radiogroup" aria-label="Hot reload">
        {[true, false].map((value) => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={on === value}
            className={on === value ? "is-active" : ""}
            onClick={() => setState((s) => ({ ...s, hotReload: value }))}
          >
            {value ? "On" : "Off"}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Shows or hides the GPU load meter in the header. */
function GpuLoadChoice() {
  const show = useStore((s) => s.showGpuLoad);
  return (
    <div className="setting-row">
      <span>GPU load meter</span>
      <div className="segmented" role="radiogroup" aria-label="GPU load meter">
        {[true, false].map((value) => (
          <button
            key={String(value)}
            type="button"
            role="radio"
            aria-checked={show === value}
            className={show === value ? "is-active" : ""}
            onClick={() => setState((s) => ({ ...s, showGpuLoad: value }))}
          >
            {value ? "Show" : "Hide"}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The daemon's address, straight to its port. The page's /api proxy points at
 * whatever daemon was running when the page loaded, which after a restart is
 * dead, so a restart must not go through it.
 */
/** Asks the daemon to restart. */
async function requestRestart() {
  const res = await fetch("/api/restart", { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res));
}

/** Waits for the restarted server to answer, then reloads the page. Gives up after a minute. */
async function reloadWhenBack() {
  const deadline = Date.now() + 60_000;
  // The old server takes a moment to close; asking straight away would reach it.
  await new Promise((r) => setTimeout(r, 1000));
  while (Date.now() < deadline) {
    try {
      // Through the page's own /api: it fails until the new daemon answers.
      if ((await fetch("/api/local/status")).ok) return window.location.reload();
    } catch {
      // Still restarting.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The app didn't come back within a minute. Check that it's still running.");
}

/**
 * Window reloads the page alone; the daemon, pi and llama-server keep running.
 * Hard restarts the daemon, which stops pi and llama-server, then reloads the page.
 */
function Restart() {
  const [state, setRestart] = useState<{ busy: boolean; error?: string }>({ busy: false });

  const reload = async () => {
    await saveNow();
    window.location.reload();
  };

  const hard = async () => {
    setRestart({ busy: true });
    // The restart kills the daemon, and the page reloads through the dead proxy,
    // so the save must finish before the request goes out. If it can't, say so
    // instead of restarting with unsaved settings.
    try {
      await saveNow();
    } catch (e) {
      setRestart({ busy: false, error: `Could not save first: ${(e as Error).message}` });
      return;
    }
    try {
      await requestRestart();
      await reloadWhenBack();
    } catch (e) {
      setRestart({ busy: false, error: (e as Error).message });
    }
  };

  return (
    <>
      <div className="setting-row">
        <span>Restart</span>
        <div className="segmented is-actions">
          <button type="button" title="Reloads this page. The loaded model keeps running." onClick={() => void reload()} disabled={state.busy}>
            <RefreshIcon size={13} />
            Window
          </button>
          <button
            type="button"
            className={state.busy ? "is-active" : ""}
            title="Restarts the daemon, which loads changes to server/ and the latest pi. The model reloads on your next message."
            onClick={hard}
            disabled={state.busy}
          >
            <RefreshIcon size={13} />
            {state.busy ? "Restarting" : "Hard"}
          </button>
        </div>
      </div>
      {state.error && <p className="test-result is-error"><AlertIcon size={15} />{state.error}</p>}
    </>
  );
}

const EDGES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = (typeof EDGES)[number];
const MIN_SIZE = { width: 560, height: 420 };

/**
 * Drag-to-resize for the settings dialog. The dialog stays centred, so an edge
 * moves twice as far as the pointer would on its own, and grows both sides at
 * once to keep the dragged edge under the pointer. The size is saved on release.
 */
function useResize() {
  const saved = useStore((s) => s.settingsSize);
  const [dragging, setDragging] = useState<{ width: number; height: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const start = (edge: Edge) => (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const x = edge.includes("e") ? 1 : edge.includes("w") ? -1 : 0;
    const y = edge.includes("s") ? 1 : edge.includes("n") ? -1 : 0;
    const from = { px: e.clientX, py: e.clientY, width: box.width, height: box.height };
    let size = { width: box.width, height: box.height };
    document.body.classList.add("is-dragging-resize");
    document.body.style.cursor = getComputedStyle(handle).cursor;

    const move = (ev: PointerEvent) => {
      const clamp = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, v)));
      size = {
        width: clamp(from.width + (ev.clientX - from.px) * x * 2, MIN_SIZE.width, window.innerWidth - 32),
        height: clamp(from.height + (ev.clientY - from.py) * y * 2, MIN_SIZE.height, window.innerHeight - 32),
      };
      setDragging(size);
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.body.classList.remove("is-dragging-resize");
      document.body.style.cursor = "";
      setDragging(null);
      setState((s) => ({ ...s, settingsSize: size }));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const size = dragging ?? saved;
  return {
    ref,
    style: size ? { width: size.width, height: size.height } : undefined,
    handles: EDGES.map((edge) => <div key={edge} className={`resize-handle is-${edge}`} onPointerDown={start(edge)} />),
  };
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const resize = useResize();
  const providers = useStore((s) => s.providers);
  // "general", "add", or a provider's id.
  const [view, setView] = useState("general");
  const adding = view === "add";
  const active = providers.find((p) => p.id === view);

  const add = (adapterId: string) => {
    const adapter = getModelAdapter(adapterId)!;
    const provider: Provider = { id: uid(), name: adapter.label, adapter: adapterId, settings: { ...adapter.defaults } };
    setState((s) => ({ ...s, providers: [...s.providers, provider] }));
    setView(provider.id);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog settings-dialog" role="dialog" aria-label="Settings" ref={resize.ref} style={resize.style}>
        <div className="dialog-body">
          <div className="provider-list">
            <button className={`provider-tab ${view === "general" ? "is-active" : ""}`} onClick={() => setView("general")}>
              <SettingsIcon size={15} />
              <span>General</span>
            </button>
            <h4 className="provider-list-heading">Model providers</h4>
            {providers.map((p) => (
              <button key={p.id} className={`provider-tab ${p.id === active?.id ? "is-active" : ""}`} onClick={() => setView(p.id)}>
                <ServerIcon size={15} />
                <span>{p.name}</span>
              </button>
            ))}
            <button className={`provider-tab is-add ${adding ? "is-active" : ""}`} onClick={() => setView("add")}>
              <PlusIcon size={15} />
              <span>Add provider</span>
            </button>
            <button className="provider-tab dialog-close" onClick={onClose}>
              <XIcon size={15} />
              <span>Close</span>
            </button>
          </div>
          <div className="provider-pane">
            {view === "general" ? (
              <div className="general-settings">
                <ContextBarChoice />
                <GpuLoadChoice />
                <HotReloadChoice />
                <Restart />
              </div>
            ) : adding ? (
              <div className="adapter-grid">
                {modelAdapters.map((a) => (
                  <button key={a.id} className="adapter-card" onClick={() => add(a.id)}>
                    <strong>{a.label}</strong>
                    <span>{a.description}</span>
                  </button>
                ))}
              </div>
            ) : active ? (
              <ProviderEditor key={active.id} provider={active} />
            ) : (
              <p className="muted">Add a provider to get started.</p>
            )}
          </div>
        </div>
        {resize.handles}
      </div>
    </div>
  );
}
