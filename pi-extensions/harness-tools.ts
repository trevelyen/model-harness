// The app's own tools for pi, loaded with `pi -e` by server/pi.ts. They let the
// model see what is running and restart it safely, instead of killing processes
// itself, which also kills the chat it is in.
//
// pi loads this file itself, so its imports resolve from pi's install. That is
// why it sits outside server/, which the app's own typecheck covers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const API = process.env.MODEL_HARNESS_API;
const RUN_ID = process.env.MODEL_HARNESS_RUN_ID;
// Only the tools the harness has switched on are registered.
const ENABLED = new Set((process.env.MODEL_HARNESS_TOOLS ?? "").split(",").filter(Boolean));

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

async function call(path: string, method = "GET", payload?: object, signal?: AbortSignal) {
  if (!API) throw new Error("MODEL_HARNESS_API is not set, so this pi was not started by the model-harness app.");
  // `timeout: false` is Bun's, which pi runs on: a staff agent's reply can take many minutes.
  const init = { method, signal, timeout: false, headers: payload ? { "content-type": "application/json" } : undefined, body: payload ? JSON.stringify(payload) : undefined };
  const res = await fetch(`${API}${path}`, init as RequestInit);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `The app answered ${res.status}`);
  return body;
}

export default function (pi: ExtensionAPI) {
  if (ENABLED.has("read_status")) {
    pi.registerTool({
      name: "read_status",
      label: "Read status",
      description: [
        "Shows what the model-harness app is running: the app and its API daemon (pid, start time, ports),",
        "files changed since each started that a restart would load (unloadedChanges),",
        "the pi runs in progress (yours has you: true), llama-server, and any restart waiting.",
        "Check this before restarting anything, and never kill the app's processes yourself:",
        "the daemon runs you, so killing it ends this chat.",
      ].join(" "),
      parameters: Type.Object({}),
      async execute() {
        const status = await call("/api/status");
        status.piRuns = status.piRuns.map((r: { chat: string }) => (r.chat === RUN_ID ? { ...r, you: true } : r));
        return text(JSON.stringify(status, null, 2));
      },
    });
  }

  if (ENABLED.has("restart_daemon")) {
    pi.registerTool({
      name: "restart_daemon",
      label: "Restart daemon",
      description: [
        "Restarts the app's API daemon, which loads changes to server/.",
        "It waits until no chat is replying, including this one, so finish your reply after calling it.",
        "The new code runs from the user's next message. pi and llama-server stop with the daemon; the model reloads on the next message.",
        "Changes in src/ reload in the browser by themselves and pi extensions load fresh each message, so neither needs this.",
      ].join(" "),
      parameters: Type.Object({}),
      async execute() {
        const { scheduled } = await call("/api/restart?target=daemon&when=idle", "POST");
        return text(`Restart scheduled (${scheduled}). It happens once this reply and any other running chats finish.`);
      },
    });
  }

  if (ENABLED.has("restart_app")) {
    pi.registerTool({
      name: "restart_app",
      label: "Restart app",
      description: [
        "Restarts Vite, which serves the page, so it loads changes to vite.config.ts or package.json, and to src/ while hot reload is off.",
        "The API daemon keeps running, so llama-server stays loaded.",
        "It waits until no chat is replying, including this one, because replies reach the browser through Vite. Finish your reply after calling it.",
        "Changes to server/ need restart_daemon instead.",
      ].join(" "),
      parameters: Type.Object({}),
      async execute() {
        const { scheduled } = await call("/api/restart?target=app&when=idle", "POST");
        return text(`Restart scheduled (${scheduled}). It happens once this reply and any other running chats finish.`);
      },
    });
  }

  if (ENABLED.has("staffagent")) {
    pi.registerTool({
      name: "staffagent",
      label: "Staff agent",
      description: [
        "Sends a message to a staff agent: a lasting child chat of this one, shown under it in the app's sidebar, and returns its reply.",
        "Unlike subagent, it remembers everything said to it before, so you can keep working with it across messages.",
        "The first message to a new name creates that staff agent; later messages to the same name continue its chat.",
        "The user can also read and type into its chat. It has the same tools and working folder as you.",
      ].join(" "),
      parameters: Type.Object({
        name: Type.String({ description: "A short name for the staff agent, such as researcher or tester. Reuse it to keep talking to the same one." }),
        message: Type.String({ description: "What to say to it." }),
      }),
      async execute(_toolCallId, params, signal) {
        const { reply } = await call("/api/staffagent", "POST", { parentId: RUN_ID, name: params.name, message: params.message }, signal);
        return text(reply || "(The staff agent replied with no text.)");
      },
    });
  }
}
