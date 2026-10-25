import { getHarnessAdapter, harnessAdapters } from "../harnesses/registry";
import type { HarnessDefinition } from "../harnesses/types";
import { setState, uid, useStore } from "../state/store";
import { HookIcon, LoopIcon, PlusIcon, ToolIcon, TrashIcon, XIcon } from "./Icons";

const PLANNED = [
  { icon: ToolIcon, title: "Tools", text: "Give the model functions to call: shell, files, web, or your own." },
  { icon: LoopIcon, title: "Agent loop", text: "Let it plan, act and check its work over several steps." },
  { icon: HookIcon, title: "Hooks", text: "Run your own code before and after each turn." },
];

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

        <div className="field">
          <label>System prompt</label>
          <textarea
            rows={5}
            placeholder="You are a helpful assistant."
            value={current.systemPrompt}
            onChange={(e) => update(current.id, { systemPrompt: e.target.value })}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label>Temperature <span className="value">{(current.params.temperature ?? 0.7).toFixed(2)}</span></label>
            <input
              type="range" min={0} max={2} step={0.05}
              value={current.params.temperature ?? 0.7}
              onChange={(e) => update(current.id, { params: { ...current.params, temperature: Number(e.target.value) } })}
            />
          </div>
          <div className="field">
            <label>Max tokens</label>
            <input
              type="number" min={1} placeholder="Model default"
              value={current.params.maxTokens ?? ""}
              onChange={(e) => update(current.id, { params: { ...current.params, maxTokens: e.target.value ? Number(e.target.value) : undefined } })}
            />
          </div>
        </div>

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
