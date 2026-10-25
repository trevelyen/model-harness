import type { HarnessAdapter, HarnessDefinition } from "./types";
import { directHarness } from "./direct";
import { commandHarness, piHarness } from "./external";

export const harnessAdapters: HarnessAdapter[] = [directHarness, piHarness, commandHarness];

export function getHarnessAdapter(id: string) {
  return harnessAdapters.find((h) => h.id === id) ?? directHarness;
}

export const defaultHarness: HarnessDefinition = {
  id: "default",
  name: "Default",
  kind: "direct",
  systemPrompt: "",
  params: { temperature: 0.7 },
  options: {},
};
