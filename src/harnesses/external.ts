import type { HarnessAdapter } from "./types";

function notConnected(name: string): HarnessAdapter["run"] {
  return async function* () {
    throw new Error(`The ${name} harness is not connected yet. Pick the Direct harness to chat for now.`);
  };
}

/** Any agent CLI that reads a prompt and streams output. */
export const commandHarness: HarnessAdapter = {
  id: "command",
  label: "Custom command",
  description: "Your own agent program, started with a command line you choose.",
  status: "stub",
  run: notConnected("custom command"),
};
