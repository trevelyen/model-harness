import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || "127.0.0.1";

// The API runs as its own process (server/daemon.ts), started by server/dev.ts.
// Nothing here imports server/, so editing it never restarts Vite.
const apiPort = Number(process.env.API_PORT);
const proxy = apiPort ? { "/api": `http://127.0.0.1:${apiPort}` } : undefined;

/**
 * Settings → Hot reload, off by default. While it's off, saved code isn't sent to
 * the page, so pi editing this app can't reload the page and cut off its own reply.
 * Vite still serves the new code, so Restart window or restart_app shows it.
 */
function hotReloadSwitch(): Plugin {
  const stateFile = resolve(process.env.MODEL_HARNESS_DATA || "data", "state.json");
  // Read on every change, so flipping the setting needs no restart.
  const on = () => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")).hotReload === true;
    } catch {
      return false;
    }
  };
  return {
    name: "model-harness-hot-reload-switch",
    hotUpdate() {
      if (this.environment.name === "client" && !on()) return [];
    },
  };
}

export default defineConfig({
  plugins: [react(), hotReloadSwitch()],
  // The hard-restart button polls the daemon straight, past the dead proxy.
  define: { "import.meta.env.VITE_API_PORT": JSON.stringify(apiPort) },
  server: { port, host, strictPort: true, proxy },
  preview: { port, host, strictPort: true, proxy },
});
