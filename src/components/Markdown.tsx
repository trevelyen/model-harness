import { memo, useMemo } from "react";
import { Marked } from "marked";
import DOMPurify from "dompurify";

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const marked = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const language = escapeHtml((lang || "text").split(/\s/)[0]);
      return `<div class="code-block"><div class="code-head"><span>${language}</span><button type="button" class="code-copy" data-copy>Copy</button></div><pre><code>${escapeHtml(text)}</code></pre></div>`;
    },
  },
});

function onClick(event: React.MouseEvent<HTMLDivElement>) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-copy]");
  if (!button) return;
  const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    window.setTimeout(() => (button.textContent = "Copy"), 1400);
  });
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }) as string), [text]);
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
