// A model adapter teaches the app how to talk to one kind of backend.
// Add a new backend by implementing ModelAdapter and registering it in registry.ts.

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type Effort = "low" | "medium" | "high";

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  maxTokens?: number;
  /** Switch thinking on or off. Undefined leaves the model's default. */
  thinking?: boolean;
  /** How hard to think, when thinking. "high" is each model's full default. */
  effort?: Effort;
}

/** What a model can do with thinking. Missing means it cannot think, or the backend cannot tell. */
export interface ReasoningSupport {
  toggle: boolean;
  /** Whether the model thinks when not told either way. */
  defaultOn: boolean;
  /** "native": the model takes effort levels. "budget": effort caps thinking tokens instead. */
  effort: "native" | "budget";
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "status"; text: string }
  | ({ type: "tool" } & ToolEvent)
  | ({ type: "usage" } & Usage);

/** A tool an agent harness ran, sent when it starts and again when it ends. */
export interface ToolEvent {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  /** The tool's output, once it has finished. */
  result?: string;
  isError?: boolean;
  done?: boolean;
}

/** Whatever a backend reports about a reply. Every field is optional. */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt tokens served from the backend's cache instead of being read again. */
  cachedTokens?: number;
  /** Tokens per second while reading the prompt. */
  promptRate?: number;
  /** Tokens per second while generating, excluding load and prompt time. */
  outputRate?: number;
  /** Time spent loading the model for this reply, when it had to load. */
  loadMs?: number;
  /** Why generation stopped, such as "stop" or "length". */
  finishReason?: string;
  /** How many tokens the backend can hold in one conversation: the limit it was started with. */
  contextWindow?: number;
  /** The most tokens the model itself can handle, whatever limit the backend was given. */
  modelContext?: number;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  params: GenerationParams;
  signal: AbortSignal;
}

export interface ModelInfo {
  id: string;
  label?: string;
  detail?: string;
  reasoning?: ReasoningSupport;
  /** Set while the model is still downloading, or stopped partway. */
  download?: { received: number; total?: number; active: boolean };
}

export interface ConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "number";
  placeholder?: string;
  help?: string;
}

export type Settings = Record<string, string>;

export interface ModelAdapter {
  id: string;
  label: string;
  description: string;
  fields: ConfigField[];
  defaults: Settings;
  /** Re-list models every couple of seconds while the model menu is open. */
  live?: boolean;
  listModels(settings: Settings, signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(settings: Settings, request: ChatRequest): AsyncIterable<ChatEvent>;
}
