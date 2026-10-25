// A harness sits between the conversation and the model. The simplest one
// sends the chat straight through; richer ones add system prompts, tools,
// agent loops, or hand the whole turn to an external program such as pi.

import type { ChatEvent, ChatMessage, GenerationParams, ModelAdapter, Settings } from "../adapters/types";

export interface HarnessDefinition {
  id: string;
  name: string;
  /** Which HarnessAdapter runs this definition. */
  kind: string;
  systemPrompt: string;
  params: GenerationParams;
  /** Free-form settings owned by the harness kind, such as a command line. */
  options: Record<string, string>;
}

export interface HarnessContext {
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
