import { useState } from "react";
import { getModelAdapter, modelAdapters } from "../adapters/registry";
import { setState, uid, useStore, type Provider } from "../state/store";
import { CheckIcon, PlusIcon, ServerIcon, TrashIcon, XIcon, AlertIcon } from "./Icons";

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

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const providers = useStore((s) => s.providers);
  const [activeId, setActiveId] = useState(providers[0]?.id);
  const [adding, setAdding] = useState(false);
  const active = providers.find((p) => p.id === activeId) ?? providers[0];

  const add = (adapterId: string) => {
    const adapter = getModelAdapter(adapterId)!;
    const provider: Provider = { id: uid(), name: adapter.label, adapter: adapterId, settings: { ...adapter.defaults } };
    setState((s) => ({ ...s, providers: [...s.providers, provider] }));
    setActiveId(provider.id);
    setAdding(false);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Settings">
        <header className="dialog-head">
          <h2>Model providers</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><XIcon size={17} /></button>
        </header>
        <div className="dialog-body">
          <div className="provider-list">
            {providers.map((p) => (
              <button key={p.id} className={`provider-tab ${p.id === active?.id ? "is-active" : ""}`} onClick={() => { setActiveId(p.id); setAdding(false); }}>
                <ServerIcon size={15} />
                <span>{p.name}</span>
              </button>
            ))}
            <button className={`provider-tab is-add ${adding ? "is-active" : ""}`} onClick={() => setAdding(true)}>
              <PlusIcon size={15} />
              <span>Add provider</span>
            </button>
          </div>
          <div className="provider-pane">
            {adding ? (
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
