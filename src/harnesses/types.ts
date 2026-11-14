// A harness sits between the conversation and the model. The simplest one
// sends the chat straight through; richer ones add system prompts, tools,
// agent loops, or hand the whole turn to an external program such as pi.

import type { ChatEvent, ChatMessage, GenerationParams, ModelAdapter, Settings } from "../adapters/types";

export interface HarnessDefinition {
  id: string;
  name: string;
  /** Which HarnessAdapter runs this definition. */
  kind: string;
  /** False sends chats straight to the model, without the system prompt, sampling settings or agent. Unset is on. */
  enabled?: boolean;
  /** Which tools pi gets, by id. A tool left out gets its default (src/harnesses/tools.ts). */
  tools?: Record<string, boolean>;
  /** pi's agent loop settings. A field left out keeps pi's default. */
  loop?: AgentLoop;
  /** Which hooks pi runs, by id. A hook left out gets its default (src/harnesses/hooks.ts). */
  hooks?: Record<string, boolean>;
  systemPrompt: string;
  params: GenerationParams;
  /** Free-form settings owned by the harness kind, such as a command line. */
  options: Record<string, string>;
}

export interface AgentLoop {
  /** Most steps pi takes with tools for one message. After that, tool calls are refused so it answers. */
  maxSteps?: number;
  /** Summarise older messages when the context is nearly full. pi's default is on. */
  compaction?: boolean;
  /** Free context, in tokens, below which compaction starts. pi's default is 16384. */
  reserveTokens?: number;
  /** Recent tokens kept word for word when compacting. pi's default is 20000. */
  keepRecentTokens?: number;
  /** Retry model requests that fail for a passing reason, such as overload. pi's default is on. */
  retry?: boolean;
  /** Most retries. pi's default is 3. */
  maxRetries?: number;
}

export interface HarnessContext {
  /** The chat this turn belongs to. Agent harnesses keep their own history under it. */
  conversationId: string;
  definition: HarnessDefinition;
  adapter: ModelAdapter;
  settings: Settings;
  model: string;
  messages: ChatMessage[];
  signal: AbortSignal;
}

export interface HarnessAdapter {
  id: string;
  label: string;
  description: string;
  /** "stub" kinds show in the editor but cannot run yet. */
  status: "ready" | "stub";
  run(context: HarnessContext): AsyncIterable<ChatEvent>;
}
