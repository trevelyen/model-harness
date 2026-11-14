// Loaded by server/pi.ts only when pi's working folder is the model-harness app
// itself and hot reload is off. Tells the model its edits reach the app on a
// restart, and to restart once, after it has finished editing.
//
// pi loads this file itself, so its imports resolve from pi's install. That is
// why it sits outside server/, which the app's own typecheck covers.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOLS = new Set((process.env.MODEL_HARNESS_TOOLS ?? "").split(",").filter(Boolean));

function note() {
  const lines = [
    "You are working on the model-harness app's own code, and this chat runs inside that app.",
    "Hot reload is off, so your edits don't show in the app until it restarts. That keeps a reload from cutting off your reply partway through.",
    "Make all your edits first. Restart once, at the end, and only when your edits are finished, never between them.",
  ];
  if (TOOLS.has("restart_app")) lines.push("For changes to src/, vite.config.ts or package.json, call restart_app.");
  if (TOOLS.has("restart_daemon")) lines.push("For changes to server/, call restart_daemon.");
  if (TOOLS.has("restart_app") || TOOLS.has("restart_daemon")) {
    lines.push("Both wait until your reply has finished, so finish your reply after calling them. Never restart or kill the app's processes yourself.");
  } else {
    lines.push("You don't have the restart tools, so when you're done, tell the user to press Restart window in Settings (Hard restart for server/ changes).");
  }
  return lines.join(" ");
}

export default function (pi: ExtensionAPI) {
  // Its own prompt section, as pi's docs advise, rather than replacing the whole prompt.
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections["model-harness"] = note();
  });
}
