// The API as its own process, beside Vite. It owns pi and llama-server, and
// nothing here watches files, so editing server/ (as pi may, when its working
// folder is this repo) never stops a reply. Changes load on Restart.
import { createServer } from "node:http";
import { appRestarted, appStatus, handle, sendJson, stopAll } from "./api.ts";
import { whenPiIdle } from "./pi.ts";

// server/dev.ts starts the daemon again when it exits with this code.
const RESTART_DAEMON = 75;

const port = Number(process.env.API_PORT);
if (!port) {
  console.error("API_PORT is not set. Start the app with npm run dev.");
  process.exit(1);
}

// "daemon" or "app" while a restart waits for pi runs to finish.
let restartPending: "daemon" | "app" | null = null;

// An app restart is Vite alone, which server/dev.ts does when asked. The daemon carries on.
function restart(target: "daemon" | "app") {
  if (target === "app") {
    restartPending = null;
    process.send?.({ restart: "vite" });
    appRestarted();
    return;
  }
  stopAll();
  process.exit(RESTART_DAEMON);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/status") return sendJson(res, 200, await appStatus(restartPending));
  if (url.pathname === "/api/restart") {
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST" });
    const target = url.searchParams.get("target") === "app" ? "app" : "daemon";
    // "idle" waits until no chat is replying, so a chat can restart the app without cutting itself off.
    if (url.searchParams.get("when") === "idle") {
      // A Vite restart cuts the browser's reply stream, which runs through its proxy, so it waits too.
      if (restartPending === target) return sendJson(res, 200, { scheduled: target });
      restartPending = target;
      sendJson(res, 200, { scheduled: target });
      whenPiIdle(() => setTimeout(() => restart(target), 100));
      return;
    }
    sendJson(res, 200, { restarting: target });
    setTimeout(() => restart(target), 100);
    return;
  }
  void handle(req, res, () => sendJson(res, 404, { error: "Not found" }));
});

// pi reuses idle connections between model requests, which can be a long tool call apart.
// Node closes them after 5s by default, and pi's next request on one fails, so keep them open.
server.keepAliveTimeout = 10 * 60_000;
server.headersTimeout = server.keepAliveTimeout + 1000;

server.listen(port, "127.0.0.1", () => console.log(`API listening on 127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}
