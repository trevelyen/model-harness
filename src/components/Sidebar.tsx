import { setState, useStore, type Conversation } from "../state/store";
import { newConversation } from "../state/chat";
import { PlusIcon, SettingsIcon, TrashIcon } from "./Icons";
import { Logo } from "./Logo";

const DAY = 86_400_000;
// Chats made after the page loaded open into the list; the ones it loaded with are just there.
const LOADED_AT = Date.now();

/** Whether a chat was just made, for its row's opening animation. Only for a second, the animation's length and then some. */
const isNew = (c: Conversation) => c.createdAt > LOADED_AT && Date.now() - c.createdAt < 1000;

/** Top-level chats by how recently they changed. Staff agents go under their parent instead. */
function group(conversations: Conversation[]) {
  const now = Date.now();
  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] },
  ];
  const ids = new Set(conversations.map((c) => c.id));
  const topLevel = conversations.filter((c) => !c.parentId || !ids.has(c.parentId));
  for (const c of topLevel.sort((a, b) => b.updatedAt - a.updatedAt)) {
    const age = now - c.updatedAt;
    groups[age < DAY ? 0 : age < 2 * DAY ? 1 : age < 7 * DAY ? 2 : 3].items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

/** Deletes a chat and its staff agents. */
function remove(id: string) {
  setState((s) => {
    const gone = new Set([id, ...s.conversations.filter((c) => c.parentId === id).map((c) => c.id)]);
    return {
      ...s,
      conversations: s.conversations.filter((c) => !gone.has(c.id)),
      activeId: s.activeId && gone.has(s.activeId) ? null : s.activeId,
    };
  });
}

/** One chat in the list. */
function HistoryItem({ conversation, active, child, onNavigate }: { conversation: Conversation; active: boolean; child?: boolean; onNavigate: () => void }) {
  return (
    <div className={`history-item ${active ? "is-active" : ""} ${child ? "is-child" : ""}`}>
      <button className="history-link" onClick={() => { setState((s) => ({ ...s, activeId: conversation.id })); onNavigate(); }}>
        {conversation.title}
      </button>
      <button className="history-delete" aria-label={child ? "Delete staff agent" : "Delete chat"} onClick={() => remove(conversation.id)}>
        <TrashIcon size={14} />
      </button>
    </div>
  );
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
        <div className="new-buttons">
          <button className="new-chat" onClick={() => { newConversation("text"); onNavigate(); }}>
            <PlusIcon size={16} />
            Text
          </button>
          <div className="new-grid">
            <button className="new-chat" onClick={() => { newConversation("voice"); onNavigate(); }}>
              <PlusIcon size={16} />
              <span>Voice</span>
            </button>
            <button className="new-chat" onClick={() => { newConversation("sound"); onNavigate(); }}>
              <PlusIcon size={16} />
              <span>Sound</span>
            </button>
            <button className="new-chat" onClick={() => { newConversation("image"); onNavigate(); }}>
              <PlusIcon size={16} />
              <span>Image</span>
            </button>
            <button className="new-chat" onClick={() => { newConversation("video"); onNavigate(); }}>
              <PlusIcon size={16} />
              <span>Video</span>
            </button>
          </div>
        </div>
      </div>
      <nav className="history">
        {group(conversations).map((g) => (
          <section key={g.label}>
            <h3>{g.label}</h3>
            {g.items.map((c) => (
              <div key={c.id} className={isNew(c) ? "history-new" : undefined}>
                <HistoryItem conversation={c} active={c.id === activeId} onNavigate={onNavigate} />
                {conversations
                  .filter((s) => s.parentId === c.id)
                  .sort((a, b) => a.createdAt - b.createdAt)
                  .map((s) => <HistoryItem key={s.id} conversation={s} active={s.id === activeId} child onNavigate={onNavigate} />)}
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
