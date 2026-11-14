// Hooks a harness can run inside pi's loop (pi-extensions/harness-hooks.ts).
// Each harness switches them on or off in its Hooks tab.

export interface HarnessHook {
  id: string;
  name: string;
  description: string;
  /** Whether a harness that has never set it gets it. */
  defaultOn: boolean;
}

export const harnessHooks: HarnessHook[] = [
  {
    id: "protect_app",
    name: "Protect the app",
    description: "Blocks shell commands that kill or start the app's own processes, and points pi at the restart tools instead. Killing the daemon ends the chat doing it.",
    defaultOn: true,
  },
  {
    id: "stay_in_folder",
    name: "Stay in the working folder",
    description: "Blocks writes and edits to files outside the working folder.",
    defaultOn: false,
  },
];

/** The ids of the hooks a harness runs. */
export function enabledHooks(hooks: Record<string, boolean> | undefined) {
  return harnessHooks.filter((h) => hooks?.[h.id] ?? h.defaultOn).map((h) => h.id);
}
