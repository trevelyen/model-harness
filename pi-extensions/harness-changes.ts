// Gives pi's write tool a patch in its result, like its edit tool already has,
// so the app's changes pane can show both. Loaded with `pi -e` by server/pi.ts.
//
// The file is read just before the write runs and again just after, inside pi,
// so nothing else can change it in between.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPatch } from "../server/diff.ts";

const read = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return ""; // A new file.
  }
};

export default function (pi: ExtensionAPI) {
  // The file as it was before each write, by tool call.
  const before = new Map<string, { path: string; text: string }>();

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write") return;
    const path = resolve(ctx.cwd, String((event.input as { path?: unknown }).path ?? ""));
    before.set(event.toolCallId, { path, text: read(path) });
  });

  pi.on("tool_result", (event) => {
    const start = before.get(event.toolCallId);
    if (!start) return;
    before.delete(event.toolCallId);
    if (event.isError) return;
    const patch = createPatch(start.path, start.text, read(start.path));
    return { details: { ...(event.details as object | undefined), patch } };
  });
}
