import { getHarnessAdapter } from "../harnesses/registry";
import { harnessHooks } from "../harnesses/hooks";
import { harnessTools, toolOn, type HarnessTool } from "../harnesses/tools";
import type { AgentLoop, HarnessDefinition } from "../harnesses/types";
import type { GenerationParams } from "../adapters/types";
import { setState, uid, useStore, type SavedPrompt } from "../state/store";
import { useEffect, useRef, useState } from "react";
import { FolderPicker } from "./FolderPicker";
import { Range } from "./Range";
import { Switch } from "./Switch";
import { Segmented } from "./Segmented";
import { Field } from "./Field";
import { CheckIcon, ChevronDownIcon, FolderIcon, PlusIcon, SaveIcon, TrashIcon, XIcon } from "./Icons";
import { useDismiss } from "../lib/useDismiss";

const TABS = ["Settings", "Tools", "Agent loop", "Hooks"] as const;
type Tab = (typeof TABS)[number];

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
    <Field label={label} value={value === off ? "Off" : value.toFixed(step < 1 ? 2 : 0)} hint={hint}>
      <Range min={min} max={max} step={step} value={value} label={label} onChange={(next) => onChange(next === off ? undefined : next)} />
    </Field>
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
    <Field label={label} value={value === undefined ? offLabel : tokens(value)} hint={hint}>
      <Range min={0} max={stops.length - 1} step={1} value={index} label={label} onChange={(i) => onChange(stops[i])} />
    </Field>
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

  const setSetting = (key: string, value: string) =>
    setState((s) => ({
      ...s,
      providers: s.providers.map((p) => (p.id === provider.id ? { ...p, settings: { ...p.settings, [key]: value } } : p)),
    }));
  const halfCache = provider.settings.kvCache === "q8_0";

  return (
    <>
      <TokenSlider
        label="Context size"
        steps={modelMax ? CONTEXT_STEPS.filter((n) => n <= modelMax) : CONTEXT_STEPS}
        value={Number(provider.settings.contextSize) || 16384}
        onChange={(n) => setSetting("contextSize", String(n))}
        hint="Most the whole chat can hold. Higher = longer chats, more VRAM. The model reloads on your next message."
      />
      <Toggle
        label="Half-size cache"
        on={halfCache}
        onChange={(on) => setSetting("kvCache", on ? "q8_0" : "")}
        hint="Stores the context at 8-bit, so the same VRAM holds about twice as much. Quality barely changes. The model reloads on your next message."
      />
    </>
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

  useDismiss(ref, open, () => setOpen(false));

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
    <Field label="System prompt">
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
    </Field>
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

/** A pill's name. Click selects the harness; click again on the selected one to rename it. */
function ChipName({ harness, active }: { harness: HarnessDefinition; active: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    const name = draft?.trim();
    if (name) update(harness.id, { name });
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <input
        className="chip-name is-editing" autoFocus value={draft} aria-label="Harness name"
        size={Math.max(draft.length, 4)}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setDraft(null);
        }}
      />
    );
  }
  return (
    <button className="chip-name" title={active ? "Rename" : undefined} onClick={() => (active ? setDraft(harness.name) : select(harness.id))}>
      <span className="chip-label">{harness.name}</span>
    </button>
  );
}

/** One tool or hook, with the switch that gives it to pi or not. */
function ToolCard({ tool, on, onToggle }: { tool: Pick<HarnessTool, "id" | "name" | "description">; on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <div className={`tool-card ${on ? "" : "is-off"}`}>
      <div className="tool-card-text">
        <strong>{tool.name}</strong>
        <code>{tool.id}</code>
        <span>{tool.description}</span>
      </div>
      <Switch on={on} label={tool.name} onChange={onToggle} />
    </div>
  );
}

const RESERVE_STEPS = [4096, 8192, 16384, 24576, 32768, 49152, 65536];
const KEEP_STEPS = [4096, 8192, 12288, 16384, 20000, 32768, 49152, 65536];

/** A labelled switch, like Half-size cache. */
function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (on: boolean) => void }) {
  return <Field label={label} control={<Switch on={on} label={label} onChange={onChange} />} hint={hint} />;
}

/** pi's loop settings: how long it may run, and how it handles a full context and failed requests. */
function AgentLoopTab({ loop, onChange }: { loop: AgentLoop; onChange: (patch: Partial<AgentLoop>) => void }) {
  const compaction = loop.compaction ?? true;
  const retry = loop.retry ?? true;
  return (
    <>
      <Slider
        label="Step limit" min={0} max={100} step={1} off={0}
        value={loop.maxSteps ?? 0}
        onChange={(v) => onChange({ maxSteps: v })}
        hint="Most steps pi takes with tools for one message. After that it's told to stop and answer. Off = no limit."
      />
      <Toggle
        label="Compact long chats" on={compaction} onChange={(on) => onChange({ compaction: on })}
        hint="When the context is nearly full, pi summarises older messages so the chat can carry on."
      />
      {compaction && (
        <>
          <TokenSlider
            label="Room kept free" steps={RESERVE_STEPS} value={loop.reserveTokens ?? 16384}
            onChange={(v) => onChange({ reserveTokens: v })}
            hint="Compacting starts when less than this is left. Higher = compacts sooner, with more room for the reply."
          />
          <TokenSlider
            label="Kept word for word" steps={KEEP_STEPS} value={loop.keepRecentTokens ?? 20000}
            onChange={(v) => onChange({ keepRecentTokens: v })}
            hint="The most recent part of the chat that isn't summarised. Higher = more detail kept, less room saved."
          />
        </>
      )}
      <Toggle
        label="Retry failed requests" on={retry} onChange={(on) => onChange({ retry: on })}
        hint="Tries again when the model is overloaded or a request fails for a passing reason."
      />
      {retry && (
        <Slider
          label="Retries" min={1} max={10} step={1}
          value={loop.maxRetries ?? 3}
          onChange={(v) => onChange({ maxRetries: v })}
          hint="Most tries before pi gives up on a request."
        />
      )}
    </>
  );
}

export function HarnessPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { harnesses, current } = useActiveHarness();
  const [browsing, setBrowsing] = useState(false);
  const [tab, setTab] = useState<Tab>("Settings");
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
        <h2>Harness</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}><XIcon size={17} /></button>
      </header>

      <div className="chips harness-chips">
        {harnesses.map((h) => {
          const on = h.enabled !== false;
          return (
            <div key={h.id} className={`chip has-switch ${h.id === current.id ? "is-active" : ""} ${on ? "" : "is-off"}`}>
              <ChipName harness={h} active={h.id === current.id} />
              <Switch
                small
                on={on}
                label={`${h.name} on`}
                title={on ? "On. Chats use this harness." : "Off. Chats go straight to the model."}
                onChange={(enabled) => update(h.id, { enabled })}
              />
            </div>
          );
        })}
        <button className="chip-add" onClick={create} aria-label="New harness"><PlusIcon size={14} /></button>
      </div>

      <Segmented tabs className="harness-tabs" label="Harness sections" options={TABS.map((t) => ({ value: t, label: t }))} value={tab} onChange={setTab} />

      <div className="harness-scroll">
        {tab === "Settings" && (<>
        <Toggle label="Use pi" on={kind.id === "pi"} onChange={(on) => update(current.id, { kind: on ? "pi" : "direct" })} />

        {kind.id === "pi" && (
          <>
            <Field
              label="Working folder"
              hint="pi reads, edits and runs commands in this folder without asking first. Pick one you're happy for it to change."
            >
              <div className="folder-input">
                <input
                  placeholder="~/code/my-project"
                  value={current.options.cwd ?? ""}
                  onChange={(e) => update(current.id, { options: { ...current.options, cwd: e.target.value } })}
                />
                <button type="button" className="icon-button" aria-label="Browse for a folder" title="Browse" onClick={() => setBrowsing(true)}>
                  <FolderIcon size={16} />
                </button>
              </div>
              {browsing && (
                <FolderPicker
                  initial={current.options.cwd ?? ""}
                  onClose={() => setBrowsing(false)}
                  onPick={(path) => {
                    update(current.id, { options: { ...current.options, cwd: path } });
                    setBrowsing(false);
                  }}
                />
              )}
            </Field>
            <Field label="pi command" hint="Empty runs pi from your PATH. The system prompt below replaces pi's own coding prompt; leave it empty to keep pi's.">
              <input
                placeholder="pi"
                value={current.options.command ?? ""}
                onChange={(e) => update(current.id, { options: { ...current.options, command: e.target.value } })}
              />
            </Field>
          </>
        )}

        {kind.status === "stub" && (
          <Field label="Command" hint="Saved with the harness. Running it is not wired up yet.">
            <input
              placeholder="my-agent --stdio"
              value={current.options.command ?? ""}
              onChange={(e) => update(current.id, { options: { ...current.options, command: e.target.value } })}
            />
          </Field>
        )}

        <SystemPrompt value={current.systemPrompt} onChange={(text) => update(current.id, { systemPrompt: text })} />

        <ContextSlider />
        <TokenSlider
          label="Max tokens"
          steps={MAX_TOKEN_STEPS}
          offLabel="Off"
          value={params.maxTokens}
          onChange={(v) => setParam("maxTokens", v)}
          hint="Lower = replies cut off sooner. Higher = longer replies. Off = model default."
        />
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

        {harnesses.length > 1 && (
          <button className="button is-ghost is-danger harness-delete" onClick={remove}>
            <TrashIcon size={15} />
            Delete this harness
          </button>
        )}
        </>)}

        {tab === "Agent loop" && (
          <>
            {kind.id !== "pi" && <small className="tool-cards-note">These only apply with Use pi on.</small>}
            <AgentLoopTab loop={current.loop ?? {}} onChange={(patch) => update(current.id, { loop: { ...current.loop, ...patch } })} />
          </>
        )}

        {tab === "Hooks" && (
          <div className="tool-cards">
            {kind.id !== "pi" && <small className="tool-cards-note">Hooks only run with Use pi on.</small>}
            <section className="tool-group">
              {harnessHooks.map((h) => (
                <ToolCard key={h.id} tool={h} on={current.hooks?.[h.id] ?? h.defaultOn} onToggle={(on) => update(current.id, { hooks: { ...current.hooks, [h.id]: on } })} />
              ))}
            </section>
          </div>
        )}

        {tab === "Tools" && (
          <div className="tool-cards">
            {kind.id !== "pi" && <small className="tool-cards-note">Tools only run with Use pi on.</small>}
            {(["pi", "app"] as const).map((group) => (
              <section key={group} className="tool-group">
                <h3>{group === "pi" ? "Pi" : "Custom"}</h3>
                {harnessTools.filter((t) => t.group === group).map((t) => (
                  <ToolCard key={t.id} tool={t} on={toolOn(current.tools, t)} onToggle={(on) => update(current.id, { tools: { ...current.tools, [t.id]: on } })} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
