import { useEffect, useState } from "react";
import { currentReasoning, setReasoning, useStore } from "./state/store";
import { send, stop } from "./state/chat";
import { Sidebar } from "./components/Sidebar";
import { ModelPicker } from "./components/ModelPicker";
import { Thread } from "./components/Thread";
import { Composer } from "./components/Composer";
import { SettingsDialog } from "./components/SettingsDialog";
import { HarnessPanel } from "./components/HarnessPanel";
import { DiffIcon, SidebarIcon, SlidersIcon } from "./components/Icons";
import { SystemMeters } from "./components/SystemMeters";
import { RestartNotice } from "./components/RestartNotice";
import { ChangesPane } from "./components/ChangesPane";

export function App() {
  const conversation = useStore((s) => s.conversations.find((c) => c.id === s.activeId));
  const hasModel = useStore((s) => !!s.selection);
  const reasoningSupport = useStore((s) => (s.selection?.reasoning?.toggle ? s.selection.reasoning : undefined));
  const reasoningChoice = useStore(currentReasoning);
  const harnessName = useStore((s) => {
    const id = s.conversations.find((c) => c.id === s.activeId)?.harnessId ?? s.harnessId;
    return s.harnesses.find((h) => h.id === id)?.name;
  });
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 860);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [harnessOpen, setHarnessOpen] = useState(false);
  // The changes pane, opened by the round button in the corner. Empty for now.
  const [changesOpen, setChangesOpen] = useState(false);
  const busy = !!conversation?.messages.at(-1)?.streaming;
  // The latest reply's prompt plus answer is what the next message builds on.
  const lastUsage = conversation?.messages.findLast((m) => m.usage?.inputTokens)?.usage;
  // A local model's limit is the setting, so moving the slider shows straight away.
  // Other backends only say what it is in a reply.
  const localLimit = useStore((s) => {
    const provider = s.providers.find((p) => p.id === s.selection?.providerId);
    return provider?.adapter === "llamacpp" ? Number(provider.settings.contextSize) || undefined : undefined;
  });
  const limit = localLimit ?? lastUsage?.contextWindow;
  const modelMax = conversation?.messages.findLast((m) => m.usage?.modelContext)?.usage?.modelContext;
  const barScale = useStore((s) => s.contextBar);
  const context = limit
    ? {
        used: lastUsage?.inputTokens ? lastUsage.inputTokens + (lastUsage.outputTokens ?? 0) : 0,
        limit,
        max: barScale === "limit" ? limit : Math.max(limit, modelMax ?? 0),
      }
    : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        setHarnessOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Crossing the narrow-window breakpoint swaps how the side panes hide, and their
  // slide transitions would play that swap as a flash. Pause them while resizing.
  useEffect(() => {
    let timer: number | undefined;
    const onResize = () => {
      document.documentElement.classList.add("is-resizing");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => document.documentElement.classList.remove("is-resizing"), 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(timer);
    };
  }, []);

  const closeOnMobile = () => window.innerWidth <= 860 && setSidebarOpen(false);

  return (
    <div className={`app ${sidebarOpen ? "has-sidebar" : ""} ${harnessOpen ? "has-harness" : ""}`}>
      <Sidebar open={sidebarOpen} onSettings={() => setSettingsOpen(true)} onNavigate={closeOnMobile} />
      <div className="scrim" onClick={() => setSidebarOpen(false)} />
      <main className="main">
        <header className="topbar">
          <button className="icon-button" aria-label="Toggle sidebar" onClick={() => setSidebarOpen((o) => !o)}>
            <SidebarIcon size={18} />
          </button>
          <ModelPicker />
          <div className="topbar-spacer" />
          <SystemMeters />
          <RestartNotice />
          <button
            className={`icon-button harness-toggle ${harnessOpen ? "is-active" : ""}`}
            aria-label="Harness"
            title="Harness (Ctrl+.)"
            onClick={() => setHarnessOpen((o) => !o)}
          >
            <SlidersIcon size={18} />
          </button>
        </header>
        {/* The chat, and beside it the changes pane, both under the header. */}
        <div className="main-body">
          <div className="chat-column">
            <Thread conversation={conversation} />
            <Composer
              busy={busy}
              onSend={(t) => void send(t)}
              onStop={() => conversation && stop(conversation.id)}
              context={context}
              settings={
                <>
                  <h3 className="composer-sheet-title">{conversation?.kind ?? "text"} settings</h3>
                  <p className="composer-sheet-note">Settings for this type of chat will go here.</p>
                </>
              }
              reasoning={reasoningSupport && { support: reasoningSupport, choice: reasoningChoice, onChange: (next) => setReasoning(() => next) }}
              hint={hasModel ? (harnessName && harnessName !== "Default" ? `Harness: ${harnessName}` : undefined) : "Choose a model to start chatting."}
            />
          </div>
          <ChangesPane open={changesOpen} />
        </div>
      </main>
      <HarnessPanel open={harnessOpen} onClose={() => setHarnessOpen(false)} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      <button
        type="button" className={`corner-button ${changesOpen ? "is-active" : ""}`}
        aria-label="Changes" aria-pressed={changesOpen} title="Changes"
        onClick={() => setChangesOpen((o) => !o)}
      >
        <DiffIcon size={19} />
      </button>
    </div>
  );
}
