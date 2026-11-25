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
 * `ready` looks at an OK answer for servers that answer before they're ready:
 * false keeps waiting, and an Error gives up with it.
 */
export async function waitUntilAnswering(
  url: string,
  timeoutMs: number,
  stopped: () => Error | undefined,
  late: string,
  ready?: (res: Response) => Promise<boolean | Error>,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const error = stopped();
    if (error) throw error;
    let verdict: boolean | Error = false;
    try {
      const res = await fetch(url);
      if (res.ok) verdict = ready ? await ready(res) : true;
    } catch {
      // Not listening yet.
    }
    if (verdict instanceof Error) throw verdict;
    if (verdict) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(late);
}
