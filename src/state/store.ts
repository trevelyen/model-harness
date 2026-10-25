import { useSyncExternalStore } from "react";
import type { Effort, ReasoningSupport, Settings, Usage } from "../adapters/types";
import type { HarnessDefinition } from "../harnesses/types";
import { defaultHarness } from "../harnesses/registry";

export interface Provider {
  id: string;
  name: string;
  adapter: string;
  settings: Settings;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
  status?: string;
  error?: string;
  streaming?: boolean;
  model?: string;
  /** The model's display name, as the model menu showed it. */
  modelLabel?: string;
  usage?: Usage;
  startedAt?: number;
  /** When the first text or reasoning arrived, after loading and reading the prompt. */
  firstTokenAt?: number;
  finishedAt?: number;
}

/** A chat's thinking settings. Undefined thinking means the model's default. */
export interface ReasoningChoice {
  thinking?: boolean;
  effort: Effort;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  harnessId: string;
  reasoning?: ReasoningChoice;
  createdAt: number;
  updatedAt: number;
}

export interface Selection {
  providerId: string;
  model: string;
  label: string;
  reasoning?: ReasoningSupport;
}

export interface State {
  providers: Provider[];
  harnesses: HarnessDefinition[];
  conversations: Conversation[];
  activeId: string | null;
  selection: Selection | null;
  harnessId: string;
  /** Thinking settings for new chats: whatever was used last. */
  reasoning: ReasoningChoice;
}

// Chats and settings live in the repo's data/ folder, through the dev server.
// The browser only keeps API keys, plus the old copy until it is moved over.
const LEGACY_KEY = "model-harness:v1";
const SECRETS_KEY = "model-harness:secrets";
const SECRET_FIELDS = ["apiKey"];

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const seed: State = {
  providers: [
    {
      id: "local",
      name: "Local GGUF",
      adapter: "llamacpp",
      settings: { modelsDir: "./models", binary: "llama-server", gpuLayers: "", contextSize: "16384", extraArgs: "" },
    },
  ],
  harnesses: [defaultHarness],
  conversations: [],
  activeId: null,
  selection: null,
  harnessId: defaultHarness.id,
  reasoning: { effort: "high" },
};

/** Fixes data saved by earlier versions. */
function migrate(saved: State): State {
  return {
    ...saved,
    providers: saved.providers
      // Earlier versions forced every layer onto the GPU, which fails for
      // models bigger than VRAM. Empty lets llama-server fit them itself.
      .map((p) => (p.adapter === "llamacpp" && p.settings.gpuLayers === "99" ? { ...p, settings: { ...p.settings, gpuLayers: "" } } : p))
      // Earlier versions seeded Ollama and LM Studio. Drop them unless edited.
      .filter(
        (p) =>
          !(p.id === "ollama" && p.settings.baseUrl === "http://127.0.0.1:11434") &&
          !(p.id === "lmstudio" && p.settings.baseUrl === "http://127.0.0.1:1234/v1"),
      ),
    // A reload mid-stream leaves messages marked as streaming.
    conversations: saved.conversations
      .map((c) => ({ ...c, messages: c.messages.map((m) => (m.streaming ? { ...m, streaming: false, status: undefined } : m)) }))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  };
}

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function withoutSecrets(p: Provider): Provider {
  const settings = { ...p.settings };
  for (const field of SECRET_FIELDS) delete settings[field];
  return { ...p, settings };
}

function saveSecrets(providers: Provider[]) {
  const secrets: Record<string, Settings> = {};
  for (const p of providers) {
    const kept = Object.fromEntries(SECRET_FIELDS.filter((f) => p.settings[f]).map((f) => [f, p.settings[f]]));
    if (Object.keys(kept).length) secrets[p.id] = kept;
  }
  try {
    localStorage.setItem(SECRETS_KEY, JSON.stringify(secrets));
  } catch {
    // Private mode; keys last for this session only.
  }
}

let state: State = seed;
const listeners = new Set<() => void>();
let saveTimer: number | undefined;

// What is already on disk, so only changes get written.
let savedSettingsJson = "";
const savedChats = new Map<string, Conversation>();

function settingsJson(s: State) {
  const { providers, harnesses, selection, harnessId, activeId, reasoning } = s;
  return JSON.stringify({ providers: providers.map(withoutSecrets), harnesses, selection, harnessId, activeId, reasoning });
}

async function put(path: string, body: string) {
  const res = await fetch(path, { method: "PUT", headers: { "content-type": "application/json" }, body, keepalive: body.length < 60_000 });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}

async function flush() {
  const s = state;
  saveSecrets(s.providers);
  try {
    const json = settingsJson(s);
    if (json !== savedSettingsJson) {
      await put("/api/data/state", json);
      savedSettingsJson = json;
    }
    for (const c of s.conversations) {
      // A streaming reply changes many times a second; save it once it ends.
      if (savedChats.get(c.id) === c || c.messages.at(-1)?.streaming) continue;
      await put(`/api/data/chats/${c.id}`, JSON.stringify(c));
      savedChats.set(c.id, c);
    }
    for (const id of [...savedChats.keys()]) {
      if (s.conversations.some((c) => c.id === id)) continue;
      const res = await fetch(`/api/data/chats/${id}`, { method: "DELETE" });
      if (res.ok) savedChats.delete(id);
    }
  } catch (error) {
    // The dev server is down or restarting; the next change retries.
    console.warn("Could not save to data/:", error);
  }
}

function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void flush(), 300);
}

window.addEventListener("pagehide", () => {
  window.clearTimeout(saveTimer);
  void flush();
});

/** Loads saved data from disk before the app first renders. */
export async function hydrate() {
  let disk: { state: Partial<State> | null; conversations: Conversation[] } | null = null;
  try {
    const res = await fetch("/api/data");
    if (res.ok) disk = await res.json();
  } catch {
    // Dev server unreachable; start from defaults.
  }
  const secrets = readLocal<Record<string, Settings>>(SECRETS_KEY) ?? {};
  const legacy = readLocal<State>(LEGACY_KEY);
  const hasDisk = !!disk && (!!disk.state || disk.conversations.length > 0);

  if (hasDisk) {
    state = migrate({ ...seed, ...disk!.state, conversations: disk!.conversations });
    state.providers = state.providers.map((p) => ({ ...p, settings: { ...p.settings, ...secrets[p.id] } }));
    savedSettingsJson = settingsJson(state);
    state.conversations.forEach((c) => savedChats.set(c.id, c));
  }
  if (legacy) {
    // Chats from before file storage: merge any not already on disk, keeping
    // the disk's settings when it has them, then drop the browser copy.
    const old = migrate({ ...seed, ...legacy });
    const missing = <T extends { id: string }>(disk: T[], browser: T[]) => browser.filter((b) => !disk.some((d) => d.id === b.id));
    state = hasDisk
      ? migrate({
          ...state,
          providers: [...state.providers, ...missing(state.providers, old.providers)],
          harnesses: [...state.harnesses, ...missing(state.harnesses, old.harnesses)],
          conversations: [...state.conversations, ...missing(state.conversations, old.conversations)],
          selection: state.selection ?? old.selection,
        })
      : old;
    await flush();
    if (state.conversations.every((c) => savedChats.get(c.id) === c)) {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch {
        // Leave it; the merge skips chats already on disk.
      }
    }
  }
}

export function getState() {
  return state;
}

export function setState(update: (s: State) => State) {
  state = update(state);
  save();
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state));
}

/** The thinking settings for the open chat, or for the next new one. */
export function currentReasoning(s: State): ReasoningChoice {
  return s.conversations.find((c) => c.id === s.activeId)?.reasoning ?? s.reasoning;
}

export function setReasoning(update: (r: ReasoningChoice) => ReasoningChoice) {
  setState((s) => {
    const next = update(currentReasoning(s));
    return {
      ...s,
      reasoning: next,
      conversations: s.conversations.map((c) => (c.id === s.activeId ? { ...c, reasoning: next } : c)),
    };
  });
}

export function updateConversation(id: string, update: (c: Conversation) => Conversation) {
  setState((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? update(c) : c)) }));
}

export function updateMessage(conversationId: string, messageId: string, update: (m: Message) => Message) {
  updateConversation(conversationId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? update(m) : m)),
  }));
}
