import { getModelAdapter } from "../adapters/registry";
import type { ChatMessage, FileChange } from "../adapters/types";
import { directHarness } from "../harnesses/direct";
import { getHarnessAdapter } from "../harnesses/registry";
import { getState, setState, uid, updateConversation, updateMessage, type Conversation, type Message, type MessagePart } from "./store";

// A fetch through Vite's proxy fails like this when a restart kills or restarts it.
const PROXY_DOWN = /failed to fetch|networkerror|load failed/i;

// A reply's controller, so a restart notice can say it was cut off.
export const running = new Map<string, AbortController>();

export function isRunning(conversationId: string) {
  return running.has(conversationId);
}

export function stop(conversationId: string) {
  running.get(conversationId)?.abort();
}

export function newConversation(title = "New chat") {
  const s = getState();
  const id = uid();
  const now = Date.now();
  setState((st) => ({
    ...st,
    activeId: id,
    conversations: [
      { id, title, messages: [], harnessId: s.harnessId, reasoning: s.reasoning, createdAt: now, updatedAt: now },
      ...st.conversations,
    ],
  }));
  return id;
}

function titleFrom(text: string) {
  const line = text.trim().split("\n")[0];
  return line.length > 48 ? `${line.slice(0, 48).trimEnd()}...` : line || "New chat";
}

export async function send(text: string) {
  const s = getState();
  let conversationId = s.activeId;
  if (!conversationId || !s.conversations.some((c) => c.id === conversationId)) conversationId = newConversation();
  await sendTo(conversationId, text);
}

/** Adds `text` to a chat as the user's message and gets the reply. */
async function sendTo(conversationId: string, text: string) {
  const user: Message = { id: uid(), role: "user", content: text };
  updateConversation(conversationId, (c) => ({
    ...c,
    // A staff agent keeps its name as its title.
    title: c.messages.length === 0 && !c.staffName ? titleFrom(text) : c.title,
    messages: [...c.messages, user],
    updatedAt: Date.now(),
  }));
  await respond(conversationId);
}

/** A new staff agent chat under `parent`. The open chat stays open. */
function newStaffConversation(parent: Conversation, name: string) {
  const id = uid();
  const now = Date.now();
  setState((s) => ({
    ...s,
    conversations: [
      { id, title: name, parentId: parent.id, staffName: name, messages: [], harnessId: parent.harnessId, reasoning: parent.reasoning, createdAt: now, updatedAt: now },
      ...s.conversations,
    ],
  }));
  return id;
}

/**
 * The parent chat's model messaged a staff agent. Runs the message in that child
 * chat, creating it the first time, as if it had been typed there, then hands the
 * reply back to the server, which returns it from the model's staffagent call.
 */
async function runStaff(parentId: string, { requestId, name, message }: { requestId: string; name: string; message: string }) {
  const answer = (body: { reply?: string; error?: string }) =>
    fetch("/api/staffagent/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, ...body }) }).catch(() => {});
  const s = getState();
  const parent = s.conversations.find((c) => c.id === parentId);
  if (!parent) return answer({ error: "The parent chat is gone." });
  if (parent.parentId) return answer({ error: "A staff agent can't have staff of its own." });
  const existing = s.conversations.find((c) => c.parentId === parentId && c.staffName === name);
  if (existing && running.has(existing.id)) return answer({ error: `${name} is already replying. Wait for it to finish, then try again.` });
  const childId = existing?.id ?? newStaffConversation(parent, name);
  await sendTo(childId, message);
  const reply = getState().conversations.find((c) => c.id === childId)?.messages.at(-1);
  if (reply?.role !== "assistant") return answer({ error: `${name} didn't reply.` });
  if (reply.error) return answer({ error: cutOffError(reply) });
  return answer({ reply: reply.content });
}

/** The reply cut off by a restart, shown by the restart notice. */
export function cutOffError(message: Message): string | undefined {
  return message.error === "cut-off" ? "The app restarted before this reply finished. Hit ↻ below to ask again." : message.error;
}

/**
 * Clears a reply's error. A reply that failed before saying anything is
 * removed entirely, so the chat reads as if it never happened.
 */

export function dismissError(conversationId: string, messageId: string) {
  updateConversation(conversationId, (c) => ({
    ...c,
    messages: c.messages.flatMap((m) => {
      if (m.id !== messageId) return [m];
      return m.content || m.reasoning ? [{ ...m, error: undefined }] : [];
    }),
  }));
}

/** Drops the last assistant reply and asks again. */
export async function regenerate(conversationId: string) {
  updateConversation(conversationId, (c) => {
    const messages = [...c.messages];
    if (messages.at(-1)?.role === "assistant") messages.pop();
    return { ...c, messages };
  });
  await respond(conversationId);
}

async function respond(conversationId: string) {
  const s = getState();
  const conversation = s.conversations.find((c) => c.id === conversationId)!;
  const assistant: Message = { id: uid(), role: "assistant", content: "", streaming: true, startedAt: Date.now() };
  const history: ChatMessage[] = conversation.messages
    .filter((m) => !m.error)
    .map((m) => ({ role: m.role, content: m.content }));
  updateConversation(conversationId, (c) => ({ ...c, messages: [...c.messages, assistant] }));
  const fail = (error: string) =>
    updateMessage(conversationId, assistant.id, (m) => ({ ...m, streaming: false, status: undefined, error, finishedAt: Date.now() }));

  const provider = s.providers.find((p) => p.id === s.selection?.providerId);
  const adapter = provider && getModelAdapter(provider.adapter);
  if (!s.selection || !provider || !adapter) return fail("Pick a model first. Use the model menu at the top.");
  const harnessDefinition = s.harnesses.find((h) => h.id === conversation.harnessId) ?? s.harnesses[0];
  // A harness switched off sends the chat as it is, keeping only the chat's own thinking choice.
  const on = harnessDefinition.enabled !== false;
  // The chat's thinking settings ride along with the harness's sampling settings.
  const choice = conversation.reasoning ?? s.reasoning;
  const supported = s.selection?.reasoning?.toggle;
  const definition = {
    ...harnessDefinition,
    systemPrompt: on ? harnessDefinition.systemPrompt : "",
    params: { ...(on ? harnessDefinition.params : {}), ...(supported ? { thinking: choice.thinking, effort: choice.effort } : {}) },
  };
  const harness = on ? getHarnessAdapter(definition.kind) : directHarness;

  const controller = new AbortController();
  running.set(conversationId, controller);
  let text = "";
  let reasoning = "";
  let usage: Message["usage"] = {};
  // Only agent harnesses send tool events; a reply without any keeps no parts.
  let parts: MessagePart[] = [];
  let changes: FileChange[] = [];
  let hasTools = false;
  let status: string | undefined;
  let firstTokenAt: number | undefined;
  let frame = 0;
  const flush = () => {
    frame = 0;
    updateMessage(conversationId, assistant.id, (m) => ({
      ...m,
      content: text,
      reasoning: reasoning || undefined,
      parts: hasTools ? parts : undefined,
      changes: changes.length ? changes : undefined,
      usage,
      status,
      firstTokenAt,
    }));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(flush);
  };

  try {
    const events = harness.run({
      definition,
      adapter,
      settings: provider.settings,
      model: s.selection.model,
      conversationId,
      messages: history,
      signal: controller.signal,
    });
    for await (const event of events) {
      if (event.type === "text" || event.type === "reasoning") {
        firstTokenAt ??= Date.now();
        if (event.type === "text") {
          // Text after a tool call starts a new paragraph.
          const last = parts.at(-1);
          if (last?.type === "text") parts = [...parts.slice(0, -1), { ...last, text: last.text + event.text }];
          else {
            if (text && !text.endsWith("\n")) text += "\n\n";
            parts = [...parts, { type: "text", text: event.text }];
          }
          text += event.text;
        } else reasoning += event.text;
        status = undefined;
      } else if (event.type === "tool") {
        const { type: _, ...tool } = event;
        hasTools = true;
        const index = parts.findIndex((p) => p.type === "tool" && p.id === tool.id);
        parts = index < 0 ? [...parts, { type: "tool", ...tool }] : parts.map((p, i) => (i === index ? { ...p, ...tool } : p));
        status = undefined;
      } else if (event.type === "staff") {
        // Runs alongside this reply, which is waiting on the staff agent's answer.
        void runStaff(conversationId, event);
        continue;
      } else if (event.type === "change") {
        changes = [...changes, { path: event.path, patch: event.patch }];
      } else if (event.type === "status") {
        status = event.text;
      } else {
        // Backends report usage in pieces; keep each field's latest value.
        const { type: _, ...fields } = event;
        const defined = Object.entries(fields).filter(([, v]) => v !== undefined);
        usage = { ...usage, ...Object.fromEntries(defined) };
      }
      schedule();
    }
    cancelAnimationFrame(frame);
    flush();
    updateMessage(conversationId, assistant.id, (m) => ({
      ...m,
      streaming: false,
      status: undefined,
      model: s.selection!.model,
      modelLabel: s.selection!.label,
      finishedAt: Date.now(),
    }));
  } catch (error) {
    cancelAnimationFrame(frame);
    flush();
    if (controller.signal.aborted) {
      updateMessage(conversationId, assistant.id, (m) => ({ ...m, streaming: false, status: undefined, finishedAt: Date.now() }));
    } else {
      // A restart killed the proxy mid-reply. Mark it so the restart notice can point at it.
      const message = (error as Error).message;
      const cutOff = PROXY_DOWN.test(message) && !message.includes(": ") && message.length < 40;
      fail(cutOff ? "cut-off" : message);
    }
  } finally {
    running.delete(conversationId);
    updateConversation(conversationId, (c) => ({ ...c, updatedAt: Date.now() }));
  }
}
