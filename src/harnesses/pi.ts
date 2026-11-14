import type { ChatEvent } from "../adapters/types";
import { errorText, ndjson } from "../lib/http";
import { enabledHooks } from "./hooks";
import { enabledTools } from "./tools";
import type { HarnessAdapter } from "./types";

/**
 * Hands each message to the pi coding agent. The dev server starts pi in the
 * harness's working folder, points it at the chat's model, and streams back
 * its text, thinking and tool calls. pi keeps the chat's history itself, one
 * session per chat, so only the newest message is sent.
 */
export const piHarness: HarnessAdapter = {
  id: "pi",
  label: "pi",
  description: "The pi coding agent. It reads, edits and runs things in a folder you choose, in a loop, until the task is done.",
  status: "ready",
  async *run({ conversationId, definition, adapter, settings, model, messages, signal }) {
    const message = messages.findLast((m) => m.role === "user")?.content ?? "";
    const { thinking, effort, ...params } = definition.params;
    const res = await fetch("/api/pi/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        conversationId,
        message,
        cwd: definition.options.cwd ?? "",
        command: definition.options.command,
        systemPrompt: definition.systemPrompt,
        thinking: thinking === undefined ? undefined : thinking ? (effort ?? "high") : "off",
        params,
        tools: enabledTools(definition.tools),
        hooks: enabledHooks(definition.hooks),
        loop: definition.loop ?? {},
        provider: { adapter: adapter.id, settings },
        model,
      }),
    });
    if (!res.ok) throw new Error(await errorText(res));
    for await (const event of ndjson<ChatEvent | { type: "error"; message: string }>(res.body!)) {
      if (event.type === "error") throw new Error(event.message);
      yield event;
    }
  },
};
