import { setState, useStore, type Conversation } from "../state/store";
import { newConversation } from "../state/chat";
import { PlusIcon, SettingsIcon, TrashIcon } from "./Icons";
import { Logo } from "./Logo";

const DAY = 86_400_000;

function group(conversations: Conversation[]) {
  const now = Date.now();
  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];
  for (const c of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const age = now - c.updatedAt;
    groups[age < DAY ? 0 : age < 2 * DAY ? 1 : age < 7 * DAY ? 2 : 3].items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

function remove(id: string) {
  setState((s) => ({
    ...s,
    conversations: s.conversations.filter((c) => c.id !== id),
    activeId: s.activeId === id ? null : s.activeId,
  }));
}

export function Sidebar({ open, onSettings, onNavigate }: { open: boolean; onSettings: () => void; onNavigate: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const activeId = useStore((s) => s.activeId);

  return (
    <aside className={`sidebar ${open ? "is-open" : ""}`}>
      <div className="sidebar-top">
        <div className="brand">
          <Logo size={24} />
          <span>Model Harness</span>
        </div>
        <button className="new-chat" onClick={() => { newConversation(); onNavigate(); }}>
          <PlusIcon size={16} />
          New chat
        </button>
      </div>
      <nav className="history">
        {conversations.length === 0 && <p className="history-empty">Your chats will show up here.</p>}
        {group(conversations).map((g) => (
          <section key={g.label}>
            <h3>{g.label}</h3>
            {g.items.map((c) => (
              <div key={c.id} className={`history-item ${c.id === activeId ? "is-active" : ""}`}>
                <button className="history-link" onClick={() => { setState((s) => ({ ...s, activeId: c.id })); onNavigate(); }}>
                  {c.title}
                </button>
                <button className="history-delete" aria-label="Delete chat" onClick={() => remove(c.id)}>
                  <TrashIcon size={14} />
                </button>
              </div>
            ))}
          </section>
        ))}
      </nav>
      <button className="sidebar-settings" onClick={onSettings}>
        <SettingsIcon size={16} />
        Settings
      </button>
    </aside>
  );
}
