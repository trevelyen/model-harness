import type { ModelAdapter } from "./types";
import { joinUrl, ndjson, request } from "../lib/http";

interface OllamaChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  // Durations are in nanoseconds.
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

const perSecond = (count?: number, ns?: number) => (count && ns ? count / (ns / 1e9) : undefined);

function formatSize(bytes: number) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export const ollamaAdapter: ModelAdapter = {
  id: "ollama",
  label: "Ollama",
  description: "Models pulled with Ollama, through its native API.",
  fields: [{ key: "baseUrl", label: "Base URL", type: "url", placeholder: "http://127.0.0.1:11434" }],
  defaults: { baseUrl: "http://127.0.0.1:11434" },
  async listModels(settings, signal) {
    const res = await request(joinUrl(settings.baseUrl, "api/tags"), { signal });
    const json = await res.json();
    return (json.models ?? []).map((m: { name: string; size: number }) => ({ id: m.name, detail: formatSize(m.size) }));
  },
  async *chat(settings, req) {
    const res = await request(joinUrl(settings.baseUrl, "api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        stream: true,
        options: { temperature: req.params.temperature, top_p: req.params.topP, num_predict: req.params.maxTokens },
      }),
    });
    for await (const chunk of ndjson<OllamaChunk>(res.body!)) {
      if (chunk.message?.thinking) yield { type: "reasoning", text: chunk.message.thinking };
      if (chunk.message?.content) yield { type: "text", text: chunk.message.content };
      if (chunk.done) {
        yield {
          type: "usage",
          inputTokens: chunk.prompt_eval_count,
          outputTokens: chunk.eval_count,
          promptRate: perSecond(chunk.prompt_eval_count, chunk.prompt_eval_duration),
          outputRate: perSecond(chunk.eval_count, chunk.eval_duration),
          // Ollama reports a few milliseconds even when the model was already loaded.
          loadMs: chunk.load_duration && chunk.load_duration > 5e8 ? chunk.load_duration / 1e6 : undefined,
          finishReason: chunk.done_reason,
        };
      }
    }
  },
};
