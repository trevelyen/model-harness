import type { HarnessAdapter } from "./types";

function notConnected(name: string): HarnessAdapter["run"] {
  return async function* () {
    throw new Error(`The ${name} harness is not connected yet. Pick the Direct harness to chat for now.`);
  };
}

/**
 * pi runs as its own process and drives the model itself. The plan is to
 * spawn it from the dev server and stream its events back as ChatEvents.
 */
export const piHarness: HarnessAdapter = {
  id: "pi",
  label: "pi",
  description: "The pi coding agent, run as an external process with its own tools and loop.",
  status: "stub",
  run: notConnected("pi"),
};

/** Any agent CLI that reads a prompt and streams output. */
export const commandHarness: HarnessAdapter = {
  id: "command",
  label: "Custom command",
  description: "Your own agent program, started with a command line you choose.",
  status: "stub",
  run: notConnected("custom command"),
};
