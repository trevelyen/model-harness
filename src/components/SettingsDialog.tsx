import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { getModelAdapter, modelAdapters } from "../adapters/registry";
import { saveNow, setState, uid, updateVoice, useStore, type Provider } from "../state/store";
import { errorText } from "../lib/http";
import { ColorPicker } from "./ColorPicker";
import { CheckIcon, PlusIcon, RefreshIcon, ServerIcon, SettingsIcon, TrashIcon, XIcon, AlertIcon } from "./Icons";
import { Modal } from "./Modal";
import { Segmented } from "./Segmented";
import { Field } from "./Field";
import { trackPointer } from "../lib/drag";

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
      <Field label="Name">
        <input value={provider.name} onChange={(e) => update({ name: e.target.value })} />
      </Field>
      <p className="adapter-note"><strong>{adapter.label}.</strong> {adapter.description}</p>
      {adapter.fields.map((f) => (
        <Field key={f.key} label={f.label} hint={f.help}>
          <input
            type={f.type === "password" ? "password" : f.type === "number" ? "number" : "text"}
            placeholder={f.placeholder}
            value={provider.settings[f.key] ?? ""}
            onChange={(e) => update({ settings: { ...provider.settings, [f.key]: e.target.value } })}
          />
        </Field>
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

/** A General setting: its name, and a choice between a few options. */
function Choice<T extends string | boolean>({ label, ...segmented }: {
  label: string;
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <Segmented label={label} {...segmented} />
    </div>
  );
}

/** Chooses what the composer's context bar measures against. */
function ContextBarChoice() {
  const scale = useStore((s) => s.contextBar);
  return <Choice label="Context bar shows" options={BAR_SCALES} value={scale} onChange={(contextBar) => setState((s) => ({ ...s, contextBar }))} />;
}

const ON_OFF = [{ value: true, label: "On" }, { value: false, label: "Off" }] as const;

/** Whether saved code reaches the page straight away, or on the next restart. */
function HotReloadChoice() {
  const on = useStore((s) => s.hotReload);
  return <Choice label="Hot reload" options={ON_OFF} value={on} onChange={(hotReload) => setState((s) => ({ ...s, hotReload }))} />;
}

const VOICE_LEAVE = [
  { value: "ask", label: "Ask" },
  { value: "stop", label: "Stop" },
  { value: "keep", label: "Keep" },
] as const;

/** What leaving a voice chat does to the voice server. */
function VoiceLeaveChoice() {
  const onLeave = useStore((s) => s.voice.onLeave ?? "ask");
  return <Choice label="Voice server after a voice chat" options={VOICE_LEAVE} value={onLeave} onChange={(choice) => updateVoice({ onLeave: choice })} />;
}

/** Whether closing the last page stops the local model and the voice server, freeing the GPU. */
function StopOnCloseChoice() {
  const on = useStore((s) => s.stopOnClose);
  return <Choice label="Stop models when the page closes" options={ON_OFF} value={on} onChange={(stopOnClose) => setState((s) => ({ ...s, stopOnClose }))} />;
}

const SHOW_HIDE = [{ value: true, label: "Show" }, { value: false, label: "Hide" }] as const;

/** Shows or hides the GPU load meter in the header. */
function GpuLoadChoice() {
  const show = useStore((s) => s.showGpuLoad);
  return <Choice label="GPU load meter" options={SHOW_HIDE} value={show} onChange={(showGpuLoad) => setState((s) => ({ ...s, showGpuLoad }))} />;
}

const ACCENTS = [
  { value: "#6d5ef0", name: "Violet" },
  { value: "#3b82f6", name: "Blue" },
  { value: "#0ea5a4", name: "Teal" },
  { value: "#2f9e6a", name: "Green" },
  { value: "#e0a020", name: "Amber" },
  { value: "#ec6a3c", name: "Orange" },
  { value: "#d6455d", name: "Red" },
  { value: "#d946a8", name: "Pink" },
];

/** Picks the accent colour. The rainbow swatch opens a picker for any colour. Reset goes back to the theme's own. */
function AccentChoice() {
  const accent = useStore((s) => s.accent);
  const set = (value: string | undefined) => setState((s) => ({ ...s, accent: value }));
  const custom = !!accent && !ACCENTS.some((c) => c.value === accent);
  const [open, setOpen] = useState(custom);
  return (
    <div className="setting-row accent-setting">
      <div className="accent-head">
        <span>Accent</span>
        <div className="accent-swatches" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((c) => (
            <button
              key={c.value}
              type="button"
              role="radio"
              aria-checked={accent === c.value}
              aria-label={c.name}
              title={c.name}
              className={`accent-swatch ${accent === c.value ? "is-active" : ""}`}
              style={{ "--swatch": c.value } as CSSProperties}
              onClick={() => set(c.value)}
            />
          ))}
          <button
            type="button"
            aria-label="Pick your own"
            aria-expanded={open}
            title="Pick your own"
            className={`accent-swatch is-custom ${custom ? "is-picked" : ""} ${open ? "is-active" : ""}`}
            style={custom ? ({ "--swatch": accent } as CSSProperties) : undefined}
            onClick={() => setOpen((o) => !o)}
          />
          {accent && (
            <button type="button" className="accent-reset" onClick={() => set(undefined)}>
              Reset
            </button>
          )}
        </div>
      </div>
      <div className={`accent-drawer ${open ? "is-open" : ""}`} inert={!open}>
        <div>
          <ColorPicker value={accent ?? ACCENTS[0].value} onChange={set} />
        </div>
      </div>
    </div>
  );
}

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
    const x = edge.includes("e") ? 1 : edge.includes("w") ? -1 : 0;
    const y = edge.includes("s") ? 1 : edge.includes("n") ? -1 : 0;
    const from = { px: e.clientX, py: e.clientY, width: box.width, height: box.height };
    let size = { width: box.width, height: box.height };
    document.body.classList.add("is-dragging-resize");
    document.body.style.cursor = getComputedStyle(handle).cursor;

    const clamp = (v: number, min: number, max: number) => Math.round(Math.max(min, Math.min(max, v)));
    trackPointer(
      e,
      (ev) => {
        size = {
          width: clamp(from.width + (ev.clientX - from.px) * x * 2, MIN_SIZE.width, window.innerWidth - 32),
          height: clamp(from.height + (ev.clientY - from.py) * y * 2, MIN_SIZE.height, window.innerHeight - 32),
        };
        setDragging(size);
      },
      () => {
        document.body.classList.remove("is-dragging-resize");
        document.body.style.cursor = "";
        setDragging(null);
        setState((s) => ({ ...s, settingsSize: size }));
      },
    );
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
    <Modal className="settings-dialog" label="Settings" onDismiss={onClose} dialogRef={resize.ref} style={resize.style}>
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
              <AccentChoice />
              <ContextBarChoice />
              <GpuLoadChoice />
              <HotReloadChoice />
              <VoiceLeaveChoice />
              <StopOnCloseChoice />
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
    </Modal>
  );
}
