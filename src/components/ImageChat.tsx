import { useEffect, useState } from "react";
import { ComposerSheet, MessageBox, SheetButton, useSheet } from "./Composer";
import { AlertIcon, ArrowUpIcon, RefreshIcon } from "./Icons";
import { Segmented } from "./Segmented";
import { updateImage, useStore, type ImageMode } from "../state/store";
import { errorText } from "../lib/http";

// Image chats, made by ComfyUI. For now the composer only picks the mode, workflow and model.

const MODES = [
  { value: "txt2img", label: "Generate", title: "Make a picture from a description" },
  { value: "img2img", label: "Enhance", title: "Remake a picture, keeping its layout" },
  { value: "edit", label: "Edit", title: "Change part of a picture, from an instruction or a mask" },
  { value: "upscale", label: "Upscale", title: "Make a picture bigger and sharper" },
] as const;

type File = { file: string; folder: string };
type Workflow = { id: string; name: string; detail: string; modes: ImageMode[]; models: File[]; missing: string[] };
type Workflows = { state: "loading" } | { state: "ok"; workflows: Workflow[]; other: File[] } | { state: "error"; message: string };

/** A model file's name without its folder and extension, and the folder it's in under ComfyUI's models folder. */
function describe(file: string) {
  const parts = file.split(/[\\/]/);
  const name = parts.pop()!.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, "");
  return { name, folder: parts.join("/") };
}

function ImageSettings({ open }: { open: boolean }) {
  const mode = useStore((s) => s.image.mode);
  const models = useStore((s) => s.image.models);
  const picked = models[mode];
  const [list, setList] = useState<Workflows>({ state: "loading" });

  const load = async () => {
    setList({ state: "loading" });
    try {
      const res = await fetch("/api/image/workflows");
      if (!res.ok) throw new Error(await errorText(res));
      const { workflows, other }: { workflows: Workflow[]; other: File[] } = await res.json();
      setList({ state: "ok", workflows, other });
    } catch (e) {
      setList({ state: "error", message: (e as Error).message.replace(/^\d+: /, "") });
    }
  };

  // Asked each time the sheet opens, so models added to ComfyUI show up.
  useEffect(() => {
    if (open) void load();
  }, [open]);

  const shown = list.state === "ok" ? list.workflows.filter((w) => w.modes.includes(mode)) : [];
  const missing = list.state === "ok" && picked && !shown.some((w) => w.id === picked.workflow && !w.missing.length && w.models.some((m) => m.file === picked.file));

  return (
    <div className="voice-settings">
      <div className="image-settings-head">
        <h3 className="composer-sheet-title">Image settings</h3>
        <div className="image-settings-tools">
          <Segmented label="Mode" value={mode} onChange={(next) => updateImage({ mode: next })} options={MODES} />
          <button type="button" className="icon-button" aria-label="Ask ComfyUI again" title="Ask ComfyUI again" disabled={list.state === "loading"} onClick={() => void load()}>
            <RefreshIcon size={15} />
          </button>
        </div>
      </div>
      {list.state === "loading" && <p className="composer-sheet-note">Asking ComfyUI for its models…</p>}
      {list.state === "error" && <p className="test-result is-error"><AlertIcon size={15} />{list.message}</p>}
      {missing && <p className="composer-sheet-note">ComfyUI can no longer run {describe(picked.file).name}. Pick another.</p>}
      {shown.map((w) => {
        const ready = w.models.length > 0 && !w.missing.length;
        return (
          <section key={w.id} className={`image-workflow ${ready ? "" : "is-unready"}`}>
            <div className="image-workflow-head">
              <strong>{w.name}</strong>
              <small>{w.detail}</small>
            </div>
            {!w.models.length ? (
              <p className="composer-sheet-note">ComfyUI has no model for this.</p>
            ) : w.missing.length > 0 && (
              <p className="composer-sheet-note">Needs {w.missing.join(", ")} in ComfyUI's models folder.</p>
            )}
            {w.models.length > 0 && (
              <div className="voice-services" role="radiogroup" aria-label={w.name}>
                {w.models.map((m) => {
                  const { name, folder } = describe(m.file);
                  const on = picked?.workflow === w.id && picked.file === m.file;
                  return (
                    <button
                      key={m.file} type="button" role="radio" aria-checked={on} className={on ? "is-active" : ""} title={m.file} disabled={!ready}
                      onClick={() => updateImage({ models: { ...models, [mode]: { workflow: w.id, file: m.file } } })}
                    >
                      <strong>{name}</strong>
                      {folder && <small>{folder}</small>}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
      {list.state === "ok" && list.other.length > 0 && (
        <details className="image-other">
          <summary>No workflow ({list.other.length})</summary>
          <p className="composer-sheet-note">Video models, and any image model without a workflow yet.</p>
          <ul>{list.other.map((m) => <li key={`${m.folder}/${m.file}`} title={m.file}>{describe(m.file).name}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

function ImageComposer() {
  const sheet = useSheet();
  const [prompt, setPrompt] = useState("");

  return (
    <div className="composer-wrap">
      <div className="composer-stack" ref={sheet.ref}>
        <ComposerSheet open={sheet.open}>
          <ImageSettings open={sheet.open} />
        </ComposerSheet>
        <form className="composer" onSubmit={(e) => e.preventDefault()}>
          <MessageBox value={prompt} onChange={setPrompt} onSubmit={() => {}} autoFocus />
          <div className="composer-bar">
            <div className="composer-bar-start">
              <SheetButton open={sheet.open} label="Image settings" onClick={() => sheet.setOpen((o) => !o)} />
            </div>
            <span />
            <div className="composer-bar-end">
              {/* Making images comes next. */}
              <button type="submit" className="send" aria-label="Make" title="Not ready yet" disabled>
                <ArrowUpIcon size={18} />
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

export function ImageChat() {
  return (
    <>
      <div className="thread is-empty">
        <div className="welcome">
          <h1>What should it draw?</h1>
        </div>
      </div>
      <ImageComposer />
    </>
  );
}
