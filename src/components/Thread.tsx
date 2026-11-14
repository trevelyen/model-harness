import { useEffect, useLayoutEffect, useRef } from "react";
import type { Conversation } from "../state/store";
import { dismissError, regenerate } from "../state/chat";
import { MessageView } from "./MessageView";

export function Thread({ conversation }: { conversation: Conversation | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const messages = conversation?.messages ?? [];
  const last = messages.at(-1);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    pinned.current = true;
  }, [conversation?.id, messages.length]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTo({ top: el.scrollHeight, behavior: last?.streaming ? "auto" : "smooth" });
  }, [messages.length, last?.content, last?.reasoning, last?.streaming, last?.error]);

  if (!messages.length) {
    return (
      <div className="thread is-empty" ref={scroller}>
        <div className="welcome">
          <h1>What are we working on?</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        {messages.map((m, i) => (
          <MessageView
            key={m.id}
            message={m}
            isLast={i === messages.length - 1}
            onRegenerate={() => void regenerate(conversation!.id)}
            onDismissError={() => dismissError(conversation!.id, m.id)}
          />
        ))}
      </div>
    </div>
  );
}
