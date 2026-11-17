import { createPortal } from "react-dom";
import { ArrowLeftIcon } from "./Icons";

/** ComfyUI's own page over the whole window, with a way back and a way out to a tab of its own. */
export function ComfyFrame({ url, onClose }: { url: string; onClose: () => void }) {
  return createPortal(
    <div className="comfy-frame" role="dialog" aria-label="ComfyUI">
      <header className="comfy-frame-bar">
        <button type="button" className="button is-ghost" onClick={onClose}>
          <ArrowLeftIcon size={15} />
          Back
        </button>
        <span className="comfy-frame-url">{url}</span>
        <a className="button is-ghost" href={url} target="_blank" rel="noreferrer" onClick={onClose}>
          Open in new tab
        </a>
      </header>
      <iframe className="comfy-frame-page" src={url} title="ComfyUI" allow="clipboard-read; clipboard-write; fullscreen" />
    </div>,
    document.body,
  );
}
