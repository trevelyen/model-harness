// Starts the API daemon and Vite together, for `npm run dev` and `npm run preview`.
// Vite forwards /api to the daemon. If Vite stops, the daemon stops with it.
// If the daemon stops, it is started again, so Restart in Settings and a crash
// both bring it back. The daemon can ask for Vite alone to be restarted.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { freePort } from "./net.ts";

// The exit code server/daemon.ts uses for Restart.
const RESTART_DAEMON = 75;

const apiPort = Number(process.env.API_PORT) || (await freePort());
const env: NodeJS.ProcessEnv = { ...process.env, API_PORT: String(apiPort), APP_STARTED_AT: String(Date.now()) };
const daemonPath = fileURLToPath(new URL("./daemon.ts", import.meta.url));
const vitePath = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));

let stopping = false;
let daemon: ChildProcess;
let vite: ChildProcess;

function startDaemon() {
  // The ipc channel carries the daemon's request to restart Vite.
  daemon = spawn(process.execPath, [daemonPath], { stdio: ["inherit", "inherit", "inherit", "ipc"], env });
  daemon.on("message", (message: { restart?: string }) => {
    if (message.restart === "vite") restartVite();
  });
  daemon.on("exit", (code) => {
    if (stopping) return;
    if (code !== RESTART_DAEMON) console.error(`API daemon exited (code ${code}); starting it again.`);
    setTimeout(startDaemon, code === RESTART_DAEMON ? 0 : 1000);
  });
}

function startVite() {
  const child = spawn(process.execPath, [vitePath, ...process.argv.slice(2)], { stdio: "inherit", env });
  vite = child;
  child.on("exit", (code) => {
    // Killed by restartVite, which starts the next one.
    if (child.killed && !stopping) return;
    stop(code ?? 0);
  });
}

/** Stops Vite and starts it again, so it loads fresh config. The daemon keeps running. */
function restartVite() {
  env.APP_STARTED_AT = String(Date.now());
  vite.once("exit", startVite);
  vite.kill("SIGTERM");
}

function stop(code: number) {
  stopping = true;
  daemon.kill("SIGTERM");
  vite.kill("SIGTERM");
  process.exitCode = code;
}

startDaemon();
startVite();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));
