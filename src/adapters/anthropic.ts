import type { ModelAdapter, ReasoningSupport } from "./types";
import { joinUrl, request, sse } from "../lib/http";

const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 24000 };
const REASONING: ReasoningSupport = { toggle: true, defaultOn: false, effort: "budget" };

export const anthropicAdapter: ModelAdapter = {
  id: "anthropic",
  label: "Anthropic",
  description: "Claude models through the Anthropic Messages API.",
  fields: [
    { key: "baseUrl", label: "Base URL", type: "url", placeholder: "https://api.anthropic.com" },
    { key: "apiKey", label: "API key", type: "password", placeholder: "sk-ant-..." },
  ],
  defaults: { baseUrl: "https://api.anthropic.com", apiKey: "" },
  async listModels(settings, signal) {
    const res = await request(joinUrl(settings.baseUrl, "v1/models?limit=100"), {
      headers: { "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01" },
      signal,
    });
    const json = await res.json();
    return (json.data ?? []).map((m: { id: string; display_name?: string }) => ({ id: m.id, label: m.display_name, reasoning: REASONING }));
  },
  async *chat(settings, req) {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    // Extended thinking takes a token budget, counted inside max_tokens, and
    // does not allow a custom temperature.
    const budget = req.params.thinking ? THINKING_BUDGETS[req.params.effort ?? "high"] : 0;
    const answerTokens = req.params.maxTokens ?? 8192;
    const res = await request(joinUrl(settings.baseUrl, "v1/messages"), {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: req.model,
        system: system || undefined,
        messages: req.messages.filter((m) => m.role !== "system"),
        max_tokens: answerTokens + budget,
        temperature: budget ? undefined : req.params.temperature,
        top_p: budget ? undefined : req.params.topP,
        thinking: budget ? { type: "enabled", budget_tokens: budget } : undefined,
        stream: true,
      }),
    });
    for await (const data of sse(res.body!)) {
      const event = JSON.parse(data);
      if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") yield { type: "text", text: event.delta.text };
        if (event.delta.type === "thinking_delta") yield { type: "reasoning", text: event.delta.thinking };
      } else if (event.type === "message_start") {
        const usage = event.message.usage ?? {};
        yield {
          type: "usage",
          inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          cachedTokens: usage.cache_read_input_tokens || undefined,
        };
      } else if (event.type === "message_delta") {
        // Anthropic calls hitting max_tokens "max_tokens"; the app uses "length".
        const reason = event.delta?.stop_reason;
        yield { type: "usage", outputTokens: event.usage?.output_tokens, finishReason: reason === "max_tokens" ? "length" : reason };
      } else if (event.type === "error") {
        throw new Error(event.error?.message ?? "Stream error");
      }
    }
  },
};
