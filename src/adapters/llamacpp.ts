import type { ChatRequest, ModelAdapter, ModelInfo, ReasoningSupport } from "./types";
import { errorText } from "../lib/http";
import { openAIChat } from "./openai";

interface LocalModel {
  path: string;
  name: string;
  size: number;
  total?: number;
  state: "ready" | "downloading" | "incomplete";
  reasoning?: ReasoningSupport;
}

function formatSize(bytes: number) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

// Thinking-token caps for models without effort levels. High is uncapped.
// Too small a cap cuts reasoning off mid-thought and makes answers worse.
const BUDGETS = { low: 1024, medium: 4096 };

/** llama.cpp request fields for the chat's thinking settings. */
function reasoningFields(support: ReasoningSupport | undefined, params: ChatRequest["params"]) {
  if (!support?.toggle) return {};
  const kwargs: Record<string, unknown> = {};
  const fields: Record<string, unknown> = { chat_template_kwargs: kwargs };
  // Always say it explicitly: Gemma 4 thinks only when asked, Qwen unless told not to.
  const thinking = params.thinking ?? support.defaultOn;
  kwargs.enable_thinking = thinking;
  if (thinking && params.effort && params.effort !== "high") {
    if (support.effort === "native") {
      kwargs.reasoning_effort = params.effort;
    } else {
      fields.reasoning_budget_tokens = BUDGETS[params.effort];
      fields.reasoning_budget_message = "\n\nI need to stop thinking and give my answer now.\n";
    }
  }
  return fields;
}

/**
 * Runs GGUF files straight from disk. The dev server starts llama-server for
 * the chosen file on first use and keeps it warm until another model is picked.
 */
export const llamaCppAdapter: ModelAdapter = {
  id: "llamacpp",
  label: "Local GGUF",
  description: "GGUF files in a folder, run with llama.cpp's llama-server.",
  fields: [
    { key: "modelsDir", label: "Models folder", type: "text", placeholder: "./models", help: "Searched three folders deep for .gguf files. Relative paths start at the repo." },
    { key: "binary", label: "llama-server path", type: "text", placeholder: "llama-server" },
    { key: "gpuLayers", label: "GPU layers", type: "text", placeholder: "auto", help: "Leave empty to fit as many layers as your VRAM holds. Set a number to override." },
    { key: "contextSize", label: "Context size", type: "number", placeholder: "16384" },
    { key: "extraArgs", label: "Extra arguments", type: "text", placeholder: "--flash-attn on" },
  ],
  live: true,
  defaults: { modelsDir: "./models", binary: "llama-server", gpuLayers: "", contextSize: "16384", extraArgs: "" },
  async listModels(settings, signal) {
    const res = await fetch(`/api/local/models?dir=${encodeURIComponent(settings.modelsDir || "./models")}`, { signal });
    if (!res.ok) throw new Error(await errorText(res));
    const json = await res.json();
    return json.models.map((m: LocalModel): ModelInfo => ({
      id: m.path,
      label: m.name,
      detail: formatSize(m.total ?? m.size),
      reasoning: m.reasoning,
      download: m.state === "ready" ? undefined : { received: m.size, total: m.total, active: m.state === "downloading" },
    }));
  },
  async *chat(settings, req) {
    yield { type: "status", text: "Loading model" };
    const res = await fetch("/api/local/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({ ...settings, model: req.model }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const { port, loadMs, reasoning } = await res.json();
    if (loadMs !== undefined) yield { type: "usage", loadMs };
    yield* openAIChat(`http://127.0.0.1:${port}/v1`, {}, req, reasoningFields(reasoning, req.params));
  },
};
