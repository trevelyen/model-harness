// The tools a harness can give pi: pi's own, and the app's (pi-extensions/harness-tools.ts).
// Each harness switches them on or off in its Tools tab.

export interface HarnessTool {
  id: string;
  name: string;
  description: string;
  group: "pi" | "app";
  /** Whether a harness that has never set it gets it. Matches pi's own defaults. */
  defaultOn: boolean;
}

export const harnessTools: HarnessTool[] = [
  { id: "read", name: "Read", description: "Read files.", group: "pi", defaultOn: true },
  { id: "bash", name: "Bash", description: "Run shell commands.", group: "pi", defaultOn: true },
  { id: "edit", name: "Edit", description: "Change files by find and replace.", group: "pi", defaultOn: true },
  { id: "write", name: "Write", description: "Create or overwrite files.", group: "pi", defaultOn: true },
  { id: "grep", name: "Grep", description: "Search file contents.", group: "pi", defaultOn: false },
  { id: "find", name: "Find", description: "Find files by name pattern.", group: "pi", defaultOn: false },
  { id: "ls", name: "List", description: "List a folder's contents.", group: "pi", defaultOn: false },
  { id: "subagent", name: "Subagent", description: "Hand tasks to helper agents that run on their own, one at a time, side by side or in a chain.", group: "pi", defaultOn: true },
  { id: "staffagent", name: "Staff agent", description: "Message a lasting child chat that remembers earlier messages. It shows under this chat in the sidebar, and you can type into it too.", group: "app", defaultOn: true },
  { id: "read_status", name: "Read status", description: "See what's running: the app, its daemon, pi runs and llama-server, and which changes haven't loaded yet.", group: "app", defaultOn: true },
  { id: "restart_daemon", name: "Restart daemon", description: "Load changes to server/. Waits until no chat is replying, so it never cuts off the one asking.", group: "app", defaultOn: true },
  { id: "restart_app", name: "Restart app", description: "Restart Vite alone, for changes to vite.config.ts or package.json, and to src/ while hot reload is off. The daemon and the loaded model keep running. Also waits until no chat is replying.", group: "app", defaultOn: true },
];

/** Whether a harness gives pi this tool. */
export function toolOn(tools: Record<string, boolean> | undefined, tool: HarnessTool) {
  return tools?.[tool.id] ?? tool.defaultOn;
}

/** The ids of the tools a harness gives pi. */
export function enabledTools(tools: Record<string, boolean> | undefined) {
  return harnessTools.filter((t) => toolOn(tools, t)).map((t) => t.id);
}
