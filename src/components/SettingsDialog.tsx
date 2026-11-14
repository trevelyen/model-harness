import { useState } from "react";
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
  { value: "model", label: "Model's maximum", title: "The full bar is the most the model can handle. Your limit shows as a lighter section." },
  { value: "limit", label: "My limit", title: "The full bar is your context size limit." },
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
      <span>
        Hot reload
        <small className="setting-hint">Shows code changes as soon as they're saved. Off, they show after Restart window, or when pi calls restart_app once it has finished editing this app. A change that reloads the page stops a reply in progress.</small>
      </span>
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
const apiDirect = () => `http://127.0.0.1:${import.meta.env.VITE_API_PORT}`;

/** The restart request, through the page's proxy, falling back to the daemon straight. */
async function requestRestart() {
  try {
    const res = await fetch("/api/restart", { method: "POST" });
    if (res.ok) return;
  } catch {
    // The proxy is down; try the daemon straight.
  }
  const res = await fetch(`${apiDirect()}/api/restart`, { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res));
}

/** Waits for the restarted server to answer, then reloads the page. Gives up after a minute. */
async function reloadWhenBack() {
  const deadline = Date.now() + 60_000;
  // The old server takes a moment to close; asking straight away would reach it.
  await new Promise((r) => setTimeout(r, 1000));
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${apiDirect()}/api/local/status`)).ok) return window.location.reload();
    } catch {
      // Still restarting.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The app didn't come back within a minute. Check that it's still running.");
}

/** Reloads the page alone. The daemon, pi and llama-server keep running. */
function RestartWindow() {
  const reload = async () => {
    await saveNow();
    window.location.reload();
  };
  return (
    <div className="setting-row">
      <span>
        Restart window
        <small className="setting-hint">Reloads this page. The daemon and the loaded model keep running. A reply in progress stops.</small>
      </span>
      <button className="button" onClick={() => void reload()}>
        <RefreshIcon size={15} />
        Restart
      </button>
    </div>
  );
}

/** Restarts the API daemon, which stops pi and llama-server, then reloads the page. */
function HardRestart() {
  const [state, setRestart] = useState<{ busy: boolean; error?: string }>({ busy: false });

  const restart = async () => {
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
        <span>
          Hard restart
          <small className="setting-hint">Restarts the daemon, which loads changes to server/ and the latest pi. Stops any reply in progress, and the model reloads on your next message.</small>
        </span>
        <button className="button" onClick={restart} disabled={state.busy}>
          <RefreshIcon size={15} />
          {state.busy ? "Restarting" : "Restart"}
        </button>
      </div>
      {state.error && <p className="test-result is-error"><AlertIcon size={15} />{state.error}</p>}
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
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
      <div className="dialog" role="dialog" aria-label="Settings">
        <header className="dialog-head">
          <h2>Settings</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><XIcon size={17} /></button>
        </header>
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
          </div>
          <div className="provider-pane">
            {view === "general" ? (
              <div className="general-settings">
                <ContextBarChoice />
                <GpuLoadChoice />
                <HotReloadChoice />
                <RestartWindow />
                <HardRestart />
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
      </div>
    </div>
  );
}
