import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// ComfyUI's pty, shown as a terminal. The daemon streams what it prints from
// /api/comfy/terminal, and what's typed here goes back to it, Ctrl+C included.

type TerminalEvent = { type: "reset" | "data"; data: string };

// Wider than the box, so long lines stay whole. The box scrolls sideways to them.
const COLUMNS = 300;

const post = (path: string, body: object) =>
  fetch(`/api/comfy/terminal/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});

export function ComfyTerminal() {
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const yBar = useRef<HTMLDivElement>(null);
  const ySpacer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const bar = yBar.current;
    const spacer = ySpacer.current;
    if (!el || !box.current || !bar || !spacer) return;
    const css = getComputedStyle(document.documentElement);
    const term = new Terminal({
      fontFamily: css.getPropertyValue("--mono").trim() || "monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5000,
      cursorBlink: true,
      theme: { background: "#0e0e11", foreground: "#e4e4ea", cursor: css.getPropertyValue("--accent").trim() || "#e4e4ea", selectionBackground: "#3a3a46" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    // Rows fit the box's height; columns stay at COLUMNS whatever its width.
    const fitRows = () => {
      const rows = fit.proposeDimensions()?.rows;
      if (rows && (rows !== term.rows || term.cols !== COLUMNS)) term.resize(COLUMNS, rows);
    };
    fitRows();

    // The pty takes this terminal's size, so lines wrap where they're shown.
    let resizeTimer: number | undefined;
    const sendSize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => void post("resize", { cols: term.cols, rows: term.rows }), 150);
    };
    sendSize();
    term.onResize(sendSize);
    term.onData((data) => void post("input", { data }));
    // xterm's own vertical scrollbar sits at the far right of its 300 columns, out
    // of view. This one sits at the box's edge and moves with it: its content is as
    // tall, in proportion to the bar, as the scrollback is to the screen.
    const syncBar = () => {
      const buffer = term.buffer.active;
      spacer.style.height = `${(bar.clientHeight * buffer.length) / term.rows}px`;
      const top = (buffer.viewportY / buffer.length) * spacer.offsetHeight;
      if (Math.abs(bar.scrollTop - top) > 1) bar.scrollTop = top;
    };
    // Moving the bar here scrolls the terminal. When syncBar moved it, the line is already the same.
    bar.onscroll = () => {
      const line = Math.round((bar.scrollTop / spacer.offsetHeight) * term.buffer.active.length);
      if (line !== term.buffer.active.viewportY) term.scrollToLine(line);
    };
    term.onScroll(syncBar);
    term.onWriteParsed(syncBar);
    term.onResize(syncBar);

    const observer = new ResizeObserver(() => {
      fitRows();
      syncBar();
    });
    observer.observe(box.current);

    const source = new EventSource("/api/comfy/terminal");
    source.onmessage = (e) => {
      const event: TerminalEvent = JSON.parse(e.data);
      if (event.type === "reset") term.reset();
      term.write(event.data, syncBar);
    };

    return () => {
      source.close();
      observer.disconnect();
      clearTimeout(resizeTimer);
      term.dispose();
    };
  }, []);

  return (
    <div className="comfy-terminal" ref={box}>
      <div className="comfy-terminal-x">
        <div className="comfy-terminal-screen" ref={ref} />
      </div>
      <div className="comfy-terminal-y" ref={yBar}>
        <div ref={ySpacer} />
      </div>
    </div>
  );
}
