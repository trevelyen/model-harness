import type { ModelAdapter } from "./types";
import { openAIAdapter } from "./openai";
import { ollamaAdapter } from "./ollama";
import { anthropicAdapter } from "./anthropic";
import { llamaCppAdapter } from "./llamacpp";
import { freeTokenAdapter } from "./freetoken";

export const modelAdapters: ModelAdapter[] = [llamaCppAdapter, freeTokenAdapter, openAIAdapter, ollamaAdapter, anthropicAdapter];

export function getModelAdapter(id: string) {
  return modelAdapters.find((a) => a.id === id);
}
