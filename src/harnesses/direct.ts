import type { HarnessAdapter } from "./types";

/** Sends the conversation to the model, with the definition's system prompt first. */
export const directHarness: HarnessAdapter = {
  id: "direct",
  label: "Direct",
  description: "Plain chat. Adds your system prompt and sampling settings, nothing else.",
  status: "ready",
  run({ definition, adapter, settings, model, messages, signal }) {
    const withSystem = definition.systemPrompt.trim()
      ? [{ role: "system" as const, content: definition.systemPrompt }, ...messages]
      : messages;
    return adapter.chat(settings, { model, messages: withSystem, params: definition.params, signal });
  },
};
