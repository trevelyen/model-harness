import { useEffect, useMemo, useRef, useState } from "react";
import type { FileChange } from "../adapters/types";
import { useStore, type Message } from "../state/store";

type Line = { kind: "context" | "add" | "remove" | "hunk"; text: string };

/** One changed file: each patch the chat made to it, in order, as diff lines. */
interface FileDiff {
  path: string;
  patches: Line[][];
  added: number;
  removed: number;
}

/** Unified patch text as diff lines, without its "---" and "+++" header. */
function parsePatch(patch: string): Line[] {
  const lines: Line[] = [];
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw === "" || raw.startsWith("\\")) continue;
    if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
    else if (raw[0] === "+") lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw[0] === "-") lines.push({ kind: "remove", text: raw.slice(1) });
    else lines.push({ kind: "context", text: raw.slice(1) });
  }
  return lines;
}

/** The chat's changes grouped by file, most recently changed last. */
function groupByFile(changes: FileChange[]): FileDiff[] {
  const files = new Map<string, FileDiff>();
  for (const change of changes) {
    const lines = parsePatch(change.patch);
    const file = files.get(change.path) ?? { path: change.path, patches: [], added: 0, removed: 0 };
    files.delete(change.path);
    file.patches.push(lines);
    file.added += lines.filter((l) => l.kind === "add").length;
    file.removed += lines.filter((l) => l.kind === "remove").length;
    files.set(change.path, file);
  }
  return [...files.values()];
}

const MARK = { context: " ", add: "+", remove: "−", hunk: "" };
const NO_MESSAGES: Message[] = [];
// Matches the slide of the sidebar and harness panel (0.42s in styles.css).
const LEAVE_MS = 420;

/** The files to draw: the current ones, plus ones just gone that are still animating out. */
function useLeavingFiles(files: FileDiff[]) {
  const [leaving, setLeaving] = useState<FileDiff[]>([]);
  const previous = useRef(files);
  useEffect(() => {
    const paths = new Set(files.map((f) => f.path));
    const gone = previous.current.filter((f) => !paths.has(f.path));
    previous.current = files;
    if (!gone.length) return;
    setLeaving((l) => [...l.filter((f) => !paths.has(f.path)), ...gone]);
    const timer = window.setTimeout(() => setLeaving((l) => l.filter((f) => !gone.includes(f))), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [files]);
  return leaving.filter((f) => !files.some((g) => g.path === f.path));
}

/** The right-hand column: a tab per file the chat's agent changed, and that file's diff, live. */
export function ChangesPane({ open }: { open: boolean }) {
  // The messages array keeps its identity until the chat changes, so this re-renders only then.
  const messages = useStore((s) => s.conversations.find((c) => c.id === s.activeId)?.messages ?? NO_MESSAGES);
  const files = useMemo(() => groupByFile(messages.flatMap((m) => m.changes ?? [])), [messages]);
  const leaving = useLeavingFiles(files);
  // The tab picked by hand. Until then, and if that file is gone, the latest changed file shows.
  const [picked, setPicked] = useState<string | null>(null);
  const diff = files.find((f) => f.path === picked) ?? files.at(-1);

  // Patches already on screen for the open file. Ones that arrive after it is shown unfold, and
  // count as seen once that has played, so a re-render meanwhile does not cut it short.
  const count = diff?.patches.length ?? 0;
  const [seen, setSeen] = useState<{ path?: string; count: number }>({ count: 0 });
  const firstNew = seen.path === diff?.path ? seen.count : count;
  useEffect(() => {
    if (seen.path !== diff?.path) return setSeen({ path: diff?.path, count });
    if (seen.count === count) return;
    const timer = window.setTimeout(() => setSeen({ path: diff?.path, count }), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [diff?.path, count, seen]);

  return (
    <section className={`changes-pane ${open ? "is-open" : ""}`} aria-label="Changes" aria-hidden={!open} inert={!open}>
      {files.length || leaving.length ? (
        <div className="changes-tabs" role="tablist" aria-label="Changed files">
          {[...files, ...leaving].map((f) => {
            const gone = leaving.includes(f);
            return (
              <button
                key={f.path} role="tab" aria-selected={f === diff} disabled={gone}
                className={`changes-tab ${f === diff ? "is-active" : ""} ${gone ? "is-leaving" : ""}`}
                onClick={() => setPicked(f.path)}
              >
                <span className="changes-tab-name">{f.path}</span>
                <span className="changes-count is-add">+{f.added}</span>
                <span className="changes-count is-remove">−{f.removed}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      {diff ? (
        <div className="changes-diff" role="tabpanel">
          {/* As wide as the longest line, so each row's colour runs the full width when scrolled. */}
          <div className="diff-lines">
            {diff.patches.map((patch, p) => (
              <div key={p} className={`diff-patch ${p >= firstNew ? "is-new" : ""}`}>
                <div>
                  {patch.map((line, i) => (
                    <div key={i} className={`diff-line is-${line.kind}`}>
                      <span className="diff-mark">{MARK[line.kind]}</span>
                      <span className="diff-text">{line.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="changes-empty">Files the model changes in this chat show up here.</p>
      )}
    </section>
  );
}
