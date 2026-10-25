import { useEffect, useState } from "react";
import { currentReasoning, setReasoning, useStore } from "./state/store";
import { send, stop } from "./state/chat";
import { Sidebar } from "./components/Sidebar";
import { ModelPicker } from "./components/ModelPicker";
import { Thread } from "./components/Thread";
import { Composer } from "./components/Composer";
import { SettingsDialog } from "./components/SettingsDialog";
import { HarnessPanel } from "./components/HarnessPanel";
import { SidebarIcon, SlidersIcon } from "./components/Icons";
import { SystemMeters } from "./components/SystemMeters";

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
  const busy = !!conversation?.messages.at(-1)?.streaming;

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
          <button
            className={`icon-button harness-toggle ${harnessOpen ? "is-active" : ""}`}
            aria-label="Harness"
            title="Harness (Ctrl+.)"
            onClick={() => setHarnessOpen((o) => !o)}
          >
            <SlidersIcon size={18} />
          </button>
        </header>
        <Thread conversation={conversation} onSuggest={(t) => void send(t)} />
        <Composer
          busy={busy}
          onSend={(t) => void send(t)}
          onStop={() => conversation && stop(conversation.id)}
          reasoning={reasoningSupport && { support: reasoningSupport, choice: reasoningChoice, onChange: (next) => setReasoning(() => next) }}
          hint={hasModel ? (harnessName && harnessName !== "Default" ? `Harness: ${harnessName}` : undefined) : "Choose a model to start chatting."}
        />
      </main>
      <HarnessPanel open={harnessOpen} onClose={() => setHarnessOpen(false)} />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
