// A line diff that writes unified patches, in the same shape pi's edit tool
// reports: "--- path", "+++ path", then "@@ -a,b +c,d @@" hunks with three
// lines of context. pi-extensions/harness-changes.ts uses it for writes.

type Op = { kind: " " | "-" | "+"; text: string };

// Past this many cells the middle of the file counts as replaced outright, to bound time and memory.
const MAX_CELLS = 4_000_000;
const CONTEXT = 3;

function splitLines(text: string) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** The edit script from `a` to `b`: shared lines kept, the rest removed or added. */
function diffLines(a: string[], b: string[]): Op[] {
  // Shared lines at either end need no table.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head: Op[] = a.slice(0, start).map((text) => ({ kind: " ", text }));
  const tail: Op[] = a.slice(endA).map((text) => ({ kind: " ", text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  const middle: Op[] = [];
  if (n * m > MAX_CELLS) {
    for (const text of midA) middle.push({ kind: "-", text });
    for (const text of midB) middle.push({ kind: "+", text });
  } else {
    // Longest common subsequence, filled from the end so the walk below goes forwards.
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        middle.push({ kind: " ", text: midA[i++] });
        j++;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        middle.push({ kind: "-", text: midA[i++] });
      } else {
        middle.push({ kind: "+", text: midB[j++] });
      }
    }
    while (i < n) middle.push({ kind: "-", text: midA[i++] });
    while (j < m) middle.push({ kind: "+", text: midB[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** A unified patch from `before` to `after`, or "" when they are the same. */
export function createPatch(path: string, before: string, after: string): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  const changed = ops.map((op, i) => (op.kind === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";

  // Changes closer than twice the context share a hunk.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const last = ranges.at(-1);
    if (last && i - last[1] <= CONTEXT * 2 + 1) last[1] = i;
    else ranges.push([i, i]);
  }

  const out = [`--- ${path}`, `+++ ${path}`];
  for (const [first, last] of ranges) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    // Line numbers where the hunk starts in each file: the lines before it that each side has.
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < from; k++) {
      if (ops[k].kind !== "+") oldLine++;
      if (ops[k].kind !== "-") newLine++;
    }
    const hunk = ops.slice(from, to + 1);
    const oldCount = hunk.filter((op) => op.kind !== "+").length;
    const newCount = hunk.filter((op) => op.kind !== "-").length;
    out.push(`@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
  }
  return `${out.join("\n")}\n`;
}
