import { useEffect, useRef, useState } from "react";
import { CheckIcon, RefreshIcon, XIcon } from "./Icons";

interface AppStatus {
  app?: { startedAt?: string };
  daemon?: { startedAt?: string };
  restartPending?: "app" | "daemon" | null;
}

const POLL_MS = 1500;
// An app restart reloads the page, so the start times seen so far are kept here to notice it.
const SEEN_KEY = "model-harness:restart-seen";

function loadSeen(): { app?: string; daemon?: string } {
  try {
    return JSON.parse(sessionStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveSeen(seen: { app?: string; daemon?: string }) {
  try {
    sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // Storage blocked; a restart that reloads the page just goes unannounced.
  }
}
const SHOW_MS = 8000;

/**
 * A banner for restarts the browser can't see itself: one scheduled from a
 * chat (restartPending) and the moment the app or daemon comes back.
 */
export function RestartNotice() {
  const [pending, setPending] = useState<string | null>(null);
  const [back, setBack] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const seen = useRef(loadSeen());
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const res = await fetch("/api/status");
          if (res.ok) {
            const status = (await res.json()) as AppStatus;
            if (!stopped) {
              const app = status.app?.startedAt;
              const daemon = status.daemon?.startedAt;
              if (app && app !== seen.current.app) {
                const first = seen.current.app === undefined;
                if (!first) setBack("app");
                seen.current.app = app;
              }
              if (daemon && daemon !== seen.current.daemon) {
                const first = seen.current.daemon === undefined;
                if (!first) setBack("daemon");
                seen.current.daemon = daemon;
              }
              saveSeen(seen.current);
              setPending(status.restartPending ?? null);
            }
          }
        } catch {
          // Mid-restart; try again next tick.
        }
      }
      if (!stopped) timer = window.setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  // The "back up" note fades on its own.
  useEffect(() => {
    if (!back) return;
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      setBack(null);
      setDismissed(null);
    }, SHOW_MS);
    return () => window.clearTimeout(hideTimer.current);
  }, [back]);

  const key = pending ?? back;
  if (!key || key === dismissed) return null;

  // One short line in the top bar; the tooltip says what it means.
  const which = (pending ?? back) === "app" ? "App" : "Daemon";
  const label = pending ? `${which} restarts after this reply` : `${which} restarted`;
  const detail = pending
    ? "It waits for replies in progress to finish, so none get cut off."
    : back === "daemon"
      ? "pi and llama-server stopped with it. The model reloads on your next message."
      : "Vite started again with the latest config.";

  return (
    <div className={`restart-notice ${pending ? "is-pending" : "is-done"}`} role="status" title={detail}>
      {pending ? <RefreshIcon size={13} /> : <CheckIcon size={13} />}
      <span className={pending ? "shimmer" : ""}>{label}</span>
      <button type="button" className="restart-dismiss" aria-label="Dismiss" onClick={() => setDismissed(key)}>
        <XIcon size={12} />
      </button>
    </div>
  );
}
