import type { ChatEvent, ChatRequest, ModelAdapter, Settings } from "./types";
import { joinUrl, request, sse } from "../lib/http";

function headers(settings: Settings) {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (settings.apiKey) h.authorization = `Bearer ${settings.apiKey}`;
  return h;
}

/** Streams a chat completion from any OpenAI-compatible endpoint. */
export async function* openAIChat(
  baseUrl: string,
  settings: Settings,
  req: ChatRequest,
  extra: Record<string, unknown> = {},
): AsyncIterable<ChatEvent> {
  const res = await request(joinUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: headers(settings),
    signal: req.signal,
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: req.params.temperature,
      top_p: req.params.topP,
      max_tokens: req.params.maxTokens,
      ...extra,
    }),
  });
  for await (const data of sse(res.body!)) {
    if (data === "[DONE]") return;
    const chunk = JSON.parse(data);
    const delta = chunk.choices?.[0]?.delta;
    const reasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (reasoning) yield { type: "reasoning", text: reasoning };
    if (delta?.content) yield { type: "text", text: delta.content };
    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason) yield { type: "usage", finishReason };
    if (chunk.usage) {
      yield {
        type: "usage",
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens || chunk.timings?.cache_n || undefined,
        // llama.cpp reports its own speeds, which exclude load time.
        promptRate: chunk.timings?.prompt_per_second,
        outputRate: chunk.timings?.predicted_per_second,
      };
    }
  }
}

export const openAIAdapter: ModelAdapter = {
  id: "openai",
  label: "OpenAI compatible",
  description: "llama.cpp server, LM Studio, vLLM, SGLang, OpenRouter, OpenAI and anything else that speaks /v1/chat/completions.",
  fields: [
    { key: "baseUrl", label: "Base URL", type: "url", placeholder: "http://127.0.0.1:8080/v1" },
    { key: "apiKey", label: "API key", type: "password", placeholder: "Optional for local servers" },
  ],
  defaults: { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "" },
  async listModels(settings, signal) {
    const res = await request(joinUrl(settings.baseUrl, "models"), { headers: headers(settings), signal });
    const json = await res.json();
    return (json.data ?? []).map((m: { id: string }) => ({ id: m.id }));
  },
  chat(settings, req) {
    // Reasoning models such as OpenAI's o-series take an effort level.
    const extra = req.params.thinking !== false && req.params.effort ? { reasoning_effort: req.params.effort } : {};
    return openAIChat(settings.baseUrl, settings, req, extra);
  },
};
