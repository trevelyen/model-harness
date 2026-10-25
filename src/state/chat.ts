import { getModelAdapter } from "../adapters/registry";
import type { ChatMessage } from "../adapters/types";
import { getHarnessAdapter } from "../harnesses/registry";
import { getState, setState, uid, updateConversation, updateMessage, type Message } from "./store";

const running = new Map<string, AbortController>();

export function isRunning(conversationId: string) {
  return running.has(conversationId);
}

export function stop(conversationId: string) {
  running.get(conversationId)?.abort();
}

export function newConversation() {
  const s = getState();
  const id = uid();
  const now = Date.now();
  setState((st) => ({
    ...st,
    activeId: id,
    conversations: [
      { id, title: "New chat", messages: [], harnessId: s.harnessId, reasoning: s.reasoning, createdAt: now, updatedAt: now },
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
  const user: Message = { id: uid(), role: "user", content: text };
  updateConversation(conversationId, (c) => ({
    ...c,
    title: c.messages.length === 0 ? titleFrom(text) : c.title,
    messages: [...c.messages, user],
    updatedAt: Date.now(),
  }));
  await respond(conversationId);
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
  // The chat's thinking settings ride along with the harness's sampling settings.
  const choice = conversation.reasoning ?? s.reasoning;
  const supported = s.selection?.reasoning?.toggle;
  const definition = {
    ...harnessDefinition,
    params: { ...harnessDefinition.params, ...(supported ? { thinking: choice.thinking, effort: choice.effort } : {}) },
  };
  const harness = getHarnessAdapter(definition.kind);

  const controller = new AbortController();
  running.set(conversationId, controller);
  let text = "";
  let reasoning = "";
  let usage: Message["usage"] = {};
  let status: string | undefined;
  let firstTokenAt: number | undefined;
  let frame = 0;
  const flush = () => {
    frame = 0;
    updateMessage(conversationId, assistant.id, (m) => ({ ...m, content: text, reasoning: reasoning || undefined, usage, status, firstTokenAt }));
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
      messages: history,
      signal: controller.signal,
    });
    for await (const event of events) {
      if (event.type === "text" || event.type === "reasoning") {
        firstTokenAt ??= Date.now();
        if (event.type === "text") text += event.text;
        else reasoning += event.text;
        status = undefined;
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
      fail((error as Error).message);
    }
  } finally {
    running.delete(conversationId);
    updateConversation(conversationId, (c) => ({ ...c, updatedAt: Date.now() }));
  }
}
