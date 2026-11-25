import type { ChatRequest, ModelAdapter, ModelFacts, ReasoningSupport } from "./types";
import { errorText } from "../lib/http";
import { openAIChat } from "./openai";
import { listLocalModels } from "./llamacpp";

// The GGUF architectures FreeToken serves, from docs/models.md in its repo.
// Hugging Face checkpoint folders are all listed, since it reads most of them.
const GGUF_ARCHS = new Set([
  "qwen35moe", "qwen35", "qwen4exp", "qwen3moe", "qwen3", "qwen3vlmoe", "qwen3vl", "qwen2", "llama", "gemma4",
  "glm4moe", "glm5-next", "deepseek4", "minimax-m2", "minimax-m3", "muse-glimmer", "gpt-oss", "flint", "ricursive",
]);

function canRun(facts?: ModelFacts) {
  if (facts?.format === "safetensors") return true;
  return !!facts?.arch && GGUF_ARCHS.has(facts.arch);
}

/** FreeToken request fields for the chat's thinking settings. It has no thinking-token cap, so effort only reaches models that take it natively. */
function reasoningFields(support: ReasoningSupport | undefined, params: ChatRequest["params"]) {
  if (!support?.toggle) return {};
  const thinking = params.thinking ?? support.defaultOn;
  const kwargs: Record<string, unknown> = { enable_thinking: thinking };
  if (thinking && params.effort && params.effort !== "high" && support.effort === "native") kwargs.reasoning_effort = params.effort;
  return { chat_template_kwargs: kwargs };
}

/**
 * Runs MoE models bigger than VRAM with FreeToken, which keeps the busy experts
 * on the GPU and the rest in RAM. The daemon starts `ft serve` on first use, in
 * place of llama-server, since one GPU holds one engine at a time.
 */
export const freeTokenAdapter: ModelAdapter = {
  id: "freetoken",
  label: "FreeToken",
  description: "GGUF files and Hugging Face checkpoint folders, run with FreeToken. Best for MoE models too big for your VRAM.",
  fields: [
    { key: "modelsDir", label: "Models folder", type: "folder", placeholder: "./models", help: "Searched three folders deep. Lists the GGUFs FreeToken can run, and folders with config.json and .safetensors files." },
    { key: "binary", label: "ft path", type: "file", placeholder: "~/freetoken/bin/ft", help: "The ft command from the venv FreeToken is installed in." },
    { key: "extraArgs", label: "Extra arguments", type: "text", placeholder: "--memory-ratio 0.85" },
  ],
  live: true,
  // contextSize is set in the harness panel, not here.
  defaults: { modelsDir: "./models", binary: "ft", contextSize: "65536", extraArgs: "" },
  listModels: (settings, signal) => listLocalModels(settings, signal, canRun),
  async *chat(settings, req) {
    yield { type: "status", text: "Loading model. The first start compiles FreeToken's kernels, which takes a few minutes." };
    const res = await fetch("/api/local/ensure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({ ...settings, model: req.model, engine: "freetoken" }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    const { modelId, loadMs, reasoning, contextWindow, modelContext } = await res.json();
    yield { type: "usage", loadMs, contextWindow, modelContext };
    // Through the daemon: FreeToken sends no CORS headers, so the page can't reach it directly.
    yield* openAIChat("/api/llama/v1", {}, { ...req, model: modelId }, reasoningFields(reasoning, req.params));
  },
};
