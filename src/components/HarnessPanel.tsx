import { getHarnessAdapter, harnessAdapters } from "../harnesses/registry";
import type { HarnessDefinition } from "../harnesses/types";
import type { GenerationParams } from "../adapters/types";
import { setState, uid, useStore, type SavedPrompt } from "../state/store";
import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, HookIcon, LoopIcon, PlusIcon, SaveIcon, ToolIcon, TrashIcon, XIcon } from "./Icons";

const PLANNED = [
  { icon: ToolIcon, title: "Tools", text: "Give the model functions to call: shell, files, web, or your own." },
  { icon: LoopIcon, title: "Agent loop", text: "Let it plan, act and check its work over several steps." },
  { icon: HookIcon, title: "Hooks", text: "Run your own code before and after each turn." },
];

interface SliderProps {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** The value that means "not set", sent to the model as nothing. */
  off?: number;
  onChange: (value: number | undefined) => void;
}

function Slider({ label, hint, min, max, step, value, off, onChange }: SliderProps) {
  return (
    <div className="field">
      <label>{label} <span className="value">{value === off ? "Off" : value.toFixed(step < 1 ? 2 : 0)}</span></label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange(next === off ? undefined : next);
        }}
      />
      <small>{hint}</small>
    </div>
  );
}

// Context sizes the slider stops at. Small ones are close together, where each step matters most.
const CONTEXT_STEPS = [4096, 8192, 16384, 24576, 32768, 49152, 65536, 98304, 131072, 196608, 262144];

// Reply lengths the max tokens slider stops at, after "Off".
const MAX_TOKEN_STEPS = [256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];

const tokens = (n: number) => (n % 1024 === 0 ? `${n / 1024}K` : n.toLocaleString());

/** A slider over a fixed list of token counts. A value between steps shows on the nearest one. */
function TokenSlider({ label, hint, steps, value, offLabel, onChange }: {
  label: string;
  hint: string;
  steps: number[];
  value: number | undefined;
  /** When given, the slider's first stop leaves the value unset. */
  offLabel?: string;
  onChange: (value: number | undefined) => void;
}) {
  const stops: (number | undefined)[] = offLabel ? [undefined, ...steps] : steps;
  const index =
    value === undefined
      ? 0
      : stops.reduce<number>((best, n, i) => (n !== undefined && Math.abs(n - value) < Math.abs((stops[best] ?? Infinity) - value) ? i : best), 0);
  return (
    <div className="field">
      <label>{label} <span className="value">{value === undefined ? offLabel : tokens(value)}</span></label>
      <input type="range" min={0} max={stops.length - 1} step={1} value={index} onChange={(e) => onChange(stops[Number(e.target.value)])} />
      <small>{hint}</small>
    </div>
  );
}

/**
 * The local model's context limit. It belongs to the provider rather than the
 * harness, since llama-server is started with it, so it applies to every chat.
 */
function ContextSlider() {
  const provider = useStore((s) => s.providers.find((p) => p.id === s.selection?.providerId));
  // The most the model can handle, once a reply in this chat has reported it.
  const modelMax = useStore((s) =>
    s.conversations.find((c) => c.id === s.activeId)?.messages.findLast((m) => m.usage?.modelContext)?.usage?.modelContext,
  );
  if (provider?.adapter !== "llamacpp") return null;

  const set = (n: number | undefined) =>
    setState((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === provider.id ? { ...p, settings: { ...p.settings, contextSize: String(n) } } : p)),
    }));

  return (
    <TokenSlider
      label="Context size"
      steps={modelMax ? CONTEXT_STEPS.filter((n) => n <= modelMax) : CONTEXT_STEPS}
      value={Number(provider.settings.contextSize) || 16384}
      onChange={set}
      hint="Most the whole chat can hold. Higher = longer chats, more VRAM. The model reloads on your next message."
    />
  );
}

/**
 * The saved prompt's name, typed straight into the box, with the saved prompts
 * listed under the chevron.
 */
function PromptName({ prompts, name, onName, onPick, onEnter }: {
  prompts: SavedPrompt[];
  name: string;
  onName: (name: string) => void;
  onPick: (prompt: SavedPrompt) => void;
  onEnter: () => void;
}) {
  const [open, setOpen] = useState(false);
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

  return (
    <div className={`prompt-menu ${open ? "is-open" : ""}`} ref={ref}>
      <input
        aria-label="Prompt name"
        placeholder="New prompt"
        value={name}
        onChange={(e) => onName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onEnter()}
      />
      <button
        type="button" className="prompt-menu-toggle" aria-label="Saved prompts" aria-haspopup="listbox" aria-expanded={open}
        disabled={prompts.length === 0} onClick={() => setOpen((o) => !o)}
      >
        <ChevronDownIcon size={15} />
      </button>
      {open && (
        <div className="prompt-menu-list" role="listbox">
          {prompts.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.name === name}
              className={`picker-item ${p.name === name ? "is-active" : ""}`}
              onClick={() => { onPick(p); setOpen(false); }}
            >
              <span className="picker-item-name">{p.name}</span>
              {p.name === name && <CheckIcon size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The system prompt box, with a row above it to name, save, pick and delete saved prompts. */
function SystemPrompt({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  const prompts = useStore((s) => s.prompts);
  const current = prompts.find((p) => p.text === value);
  const [name, setName] = useState(current?.name ?? "");

  // Follow the box: switching harness, or loading a prompt, shows its name.
  useEffect(() => {
    if (current) setName(current.name);
  }, [current?.id]);

  const trimmed = name.trim();
  const named = prompts.find((p) => p.name === trimmed);
  const canSave = !!trimmed && !!value.trim() && !(named && named.text === value);

  const save = () => {
    if (!canSave) return;
    setState((s) => {
      const existing = s.prompts.find((p) => p.name === trimmed);
      // Same name: replace its text. Same text under another name: rename it. Otherwise a new prompt.
      const target = existing ?? s.prompts.find((p) => p.text === value);
      return {
        ...s,
        prompts: target
          ? s.prompts.map((p) => (p.id === target.id ? { ...p, name: trimmed, text: value } : p))
          : [...s.prompts, { id: uid(), name: trimmed, text: value }],
      };
    });
  };

  const remove = () => named && setState((s) => ({ ...s, prompts: s.prompts.filter((p) => p.id !== named.id) }));

  return (
    <div className="field">
      <label>System prompt</label>
      <div className="prompt-picker">
        <PromptName
          prompts={prompts}
          name={name}
          onName={setName}
          onPick={(p) => { setName(p.name); onChange(p.text); }}
          onEnter={save}
        />
        <button
          type="button" className="icon-button" aria-label="New prompt" title="Start a new prompt"
          disabled={!value && !name} onClick={() => { setName(""); onChange(""); }}
        >
          <PlusIcon size={15} />
        </button>
        <button
          type="button" className="icon-button" aria-label="Save prompt"
          title={!trimmed ? "Type a name to save" : canSave ? `Save as ${trimmed}` : "Saved"}
          disabled={!canSave} onClick={save}
        >
          <SaveIcon size={15} />
        </button>
        <button
          type="button" className="icon-button" aria-label="Delete saved prompt"
          title={named ? `Delete ${named.name}` : "Nothing saved under this name"}
          disabled={!named} onClick={remove}
        >
          <TrashIcon size={15} />
        </button>
      </div>
      <textarea rows={5} placeholder="You are a helpful assistant." value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function useActiveHarness() {
  const harnesses = useStore((s) => s.harnesses);
  const activeHarnessId = useStore((s) => s.conversations.find((c) => c.id === s.activeId)?.harnessId ?? s.harnessId);
  return { harnesses, current: harnesses.find((h) => h.id === activeHarnessId) ?? harnesses[0] };
}

function select(id: string) {
  setState((s) => ({
    ...s,
    harnessId: id,
    conversations: s.conversations.map((c) => (c.id === s.activeId ? { ...c, harnessId: id } : c)),
  }));
}

function update(id: string, patch: Partial<HarnessDefinition>) {
  setState((s) => ({ ...s, harnesses: s.harnesses.map((h) => (h.id === id ? { ...h, ...patch } : h)) }));
}

export function HarnessPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { harnesses, current } = useActiveHarness();
  const kind = getHarnessAdapter(current.kind);
  const params = current.params;
  const setParam = (key: keyof GenerationParams, value: number | undefined) =>
    update(current.id, { params: { ...params, [key]: value } });

  const create = () => {
    const h: HarnessDefinition = { id: uid(), name: `Harness ${harnesses.length + 1}`, kind: "direct", systemPrompt: "", params: { temperature: 0.7 }, options: {} };
    setState((s) => ({ ...s, harnesses: [...s.harnesses, h] }));
    select(h.id);
  };

  const remove = () => {
    if (harnesses.length < 2) return;
    const fallback = harnesses.find((h) => h.id !== current.id)!;
    setState((s) => ({
      ...s,
      harnesses: s.harnesses.filter((h) => h.id !== current.id),
      harnessId: s.harnessId === current.id ? fallback.id : s.harnessId,
      conversations: s.conversations.map((c) => (c.harnessId === current.id ? { ...c, harnessId: fallback.id } : c)),
    }));
  };

  return (
    <aside className={`harness ${open ? "is-open" : ""}`} aria-hidden={!open}>
      <header className="harness-head">
        <div>
          <h2>Harness</h2>
          <p>How this chat talks to the model.</p>
        </div>
        <button className="icon-button" aria-label="Close" onClick={onClose}><XIcon size={17} /></button>
      </header>

      <div className="harness-scroll">
        <div className="chips">
          {harnesses.map((h) => (
            <button key={h.id} className={`chip ${h.id === current.id ? "is-active" : ""}`} onClick={() => select(h.id)}>{h.name}</button>
          ))}
          <button className="chip is-add" onClick={create} aria-label="New harness"><PlusIcon size={14} /></button>
        </div>

        <div className="field">
          <label>Name</label>
          <input value={current.name} onChange={(e) => update(current.id, { name: e.target.value })} />
        </div>

        <div className="field">
          <label>Runs with</label>
          <div className="kind-list">
            {harnessAdapters.map((a) => (
              <button key={a.id} className={`kind ${a.id === current.kind ? "is-active" : ""}`} onClick={() => update(current.id, { kind: a.id })}>
                <span className="kind-title">
                  {a.label}
                  {a.status === "stub" && <em className="badge">Soon</em>}
                </span>
                <span className="kind-text">{a.description}</span>
              </button>
            ))}
          </div>
        </div>

        {kind.status === "stub" && (
          <div className="field">
            <label>Command</label>
            <input
              placeholder={kind.id === "pi" ? "pi --mode rpc" : "my-agent --stdio"}
              value={current.options.command ?? ""}
              onChange={(e) => update(current.id, { options: { ...current.options, command: e.target.value } })}
            />
            <small>Saved with the harness. Running it is not wired up yet.</small>
          </div>
        )}

        <SystemPrompt value={current.systemPrompt} onChange={(text) => update(current.id, { systemPrompt: text })} />

        <Slider
          label="Temperature" min={0} max={2} step={0.05}
          value={params.temperature ?? 0.7}
          onChange={(v) => setParam("temperature", v)}
          hint="Lower = safe, repeatable. Higher = varied, may ramble."
        />
        <Slider
          label="Top-p" min={0.05} max={1} step={0.05} off={1}
          value={params.topP ?? 1}
          onChange={(v) => setParam("topP", v)}
          hint="Lower = only common words. Higher = rare words allowed. 1 = off."
        />
        <Slider
          label="Top-k" min={0} max={100} step={1} off={0}
          value={params.topK ?? 0}
          onChange={(v) => setParam("topK", v)}
          hint="Lower = fewer word options. Higher = more options. 0 = off."
        />
        <Slider
          label="Min-p" min={0} max={0.5} step={0.01} off={0}
          value={params.minP ?? 0}
          onChange={(v) => setParam("minP", v)}
          hint="Lower = rare words allowed. Higher = only strong picks. 0 = off."
        />
        <ContextSlider />
        <TokenSlider
          label="Max tokens"
          steps={MAX_TOKEN_STEPS}
          offLabel="Off"
          value={params.maxTokens}
          onChange={(v) => setParam("maxTokens", v)}
          hint="Lower = replies cut off sooner. Higher = longer replies. Off = model default."
        />

        <div className="planned">
          {PLANNED.map(({ icon: Icon, title, text }) => (
            <div key={title} className="planned-card">
              <Icon size={17} />
              <div>
                <strong>{title} <em className="badge">Soon</em></strong>
                <span>{text}</span>
              </div>
            </div>
          ))}
        </div>

        {harnesses.length > 1 && (
          <button className="button is-ghost is-danger harness-delete" onClick={remove}>
            <TrashIcon size={15} />
            Delete this harness
          </button>
        )}
      </div>
    </aside>
  );
}
