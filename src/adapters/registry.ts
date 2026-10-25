import type { ModelAdapter } from "./types";
import { openAIAdapter } from "./openai";
import { ollamaAdapter } from "./ollama";
import { anthropicAdapter } from "./anthropic";
import { llamaCppAdapter } from "./llamacpp";

export const modelAdapters: ModelAdapter[] = [llamaCppAdapter, openAIAdapter, ollamaAdapter, anthropicAdapter];

export function getModelAdapter(id: string) {
  return modelAdapters.find((a) => a.id === id);
}
