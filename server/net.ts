import { createServer } from "node:net";

/** A port nothing is listening on, for a process the app starts. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("No port"))));
    });
  });
}

/**
 * Waits until `url` answers OK, checking twice a second. Throws what `stopped`
 * returns once the process behind it has died, or `late` after `timeoutMs`.
 */
export async function waitUntilAnswering(url: string, timeoutMs: number, stopped: () => Error | undefined, late: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = stopped();
    if (error) throw error;
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(late);
}
