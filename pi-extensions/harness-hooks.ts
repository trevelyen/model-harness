// Hooks the app runs inside pi's loop, loaded with `pi -e` by server/pi.ts:
// the step limit, and the hooks switched on in the harness's Hooks tab.
//
// pi loads this file itself, so its imports resolve from pi's install. That is
// why it sits outside server/, which the app's own typecheck covers.
import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve } from "node:path";

const HOOKS = new Set((process.env.MODEL_HARNESS_HOOKS ?? "").split(",").filter(Boolean));
const MAX_STEPS = Number(process.env.MODEL_HARNESS_MAX_STEPS) || 0;
const API = process.env.MODEL_HARNESS_API;

// Commands that stop or start the app's own processes: the launcher, daemon, Vite and llama-server.
const KILL = /\b(kill|pkill|killall|fuser\s+-k)\b/;
const APP_PROCESS = /server\/(dev|daemon)\.ts|\bvite\b|llama-server|model-harness|npm run (dev|preview)/;
const START_APP = /\bnpm\s+run\s+(dev|preview)\b|\bnode\s+\S*server\/(dev|daemon)\.ts\b|\bnpx\s+vite(\s+(dev|serve|preview))?\s*($|[;&|])/;

/** The pids a bare `kill <pid>` must not reach: the daemon running pi, and its llama-server. */
async function appPids() {
  const pids = new Set([process.ppid]);
  try {
    const status = await (await fetch(`${API}/api/status`)).json();
    if (status.llamaServer?.pid) pids.add(status.llamaServer.pid);
  } catch {
    // The daemon's own pid is still covered.
  }
  return pids;
}

const RESTART_HINT =
  "Use read_status to see what's running, then restart_daemon for server/ changes or restart_app for vite.config.ts or package.json. Both wait for this reply to finish.";

export default function (pi: ExtensionAPI) {
  let steps = 0;
  pi.on("turn_start", () => {
    steps++;
  });

  pi.on("tool_call", async (event, ctx) => {
    // Past the limit, tool calls are refused, so the step after has to answer instead.
    if (MAX_STEPS && steps > MAX_STEPS) {
      return { block: true, reason: `Step limit reached (${MAX_STEPS}). Don't call any more tools. Answer now with what you have.` };
    }

    if (HOOKS.has("protect_app") && isToolCallEventType("bash", event)) {
      const command = event.input.command;
      if (KILL.test(command) && APP_PROCESS.test(command)) {
        return { block: true, reason: `Blocked: this would stop the app's own processes, which also ends this chat. ${RESTART_HINT}` };
      }
      if (KILL.test(command)) {
        const protectedPids = await appPids();
        const hit = command.match(/\b\d+\b/g)?.find((n) => protectedPids.has(Number(n)));
        if (hit) return { block: true, reason: `Blocked: pid ${hit} is the app's own process, and stopping it ends this chat. ${RESTART_HINT}` };
      }
      if (START_APP.test(command)) {
        return { block: true, reason: `Blocked: the app is already running, under petalcode. A second copy would fight it for its ports. ${RESTART_HINT}` };
      }
    }

    if (HOOKS.has("stay_in_folder") && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
      const target = resolve(ctx.cwd, event.input.path);
      const inside = relative(ctx.cwd, target);
      if (inside.startsWith("..") || isAbsolute(inside)) {
        return { block: true, reason: `Blocked: ${target} is outside the working folder, ${ctx.cwd}. Only change files inside it.` };
      }
    }
  });
}
