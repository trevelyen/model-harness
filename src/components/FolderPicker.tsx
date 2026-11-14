import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { errorText } from "../lib/http";
import { AlertIcon, ArrowLeftIcon, FolderIcon, HomeIcon, XIcon } from "./Icons";

type Listing = { path: string; parent: string | null; home: string; folders: string[] };

/** A dialog for choosing a folder on this machine, browsed through the dev server. */
export function FolderPicker({ initial, onPick, onClose }: { initial: string; onPick: (path: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState(initial || "~");
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/fs/folders?dir=${encodeURIComponent(dir)}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorText(res));
        const next: Listing = await res.json();
        setListing(next);
        setTyped(next.path);
        setError(null);
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        setError(e.message.replace(/^\d+: /, ""));
        // A folder that won't open keeps the last good one on screen.
        if (listing) setTyped(listing.path);
      });
    return () => controller.abort();
  }, [dir]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  const folders = listing?.folders.filter((f) => showHidden || !f.startsWith(".")) ?? [];
  const hiddenCount = (listing?.folders.length ?? 0) - (listing?.folders.filter((f) => !f.startsWith(".")).length ?? 0);
  const open = (name: string) => listing && setDir(`${listing.path.replace(/\/$/, "")}/${name}`);

  // Rendered on <body>, so the harness panel's slide-in transform can't trap it.
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog folder-dialog" role="dialog" aria-label="Choose a folder">
        <header className="dialog-head">
          <h2>Choose a folder</h2>
          <button className="icon-button" aria-label="Close" onClick={onClose}><XIcon size={17} /></button>
        </header>
        <form className="folder-path" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setDir(typed.trim()); }}>
          <button type="button" className="icon-button" aria-label="Up one folder" title="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && setDir(listing.parent)}>
            <ArrowLeftIcon size={16} />
          </button>
          <button type="button" className="icon-button" aria-label="Home folder" title="Home folder" onClick={() => setDir("~")}>
            <HomeIcon size={16} />
          </button>
          <input aria-label="Folder path" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        </form>
        {error && <p className="folder-error"><AlertIcon size={15} />{error}</p>}
        <div className="folder-list">
          {listing && folders.length === 0 && <p className="picker-note">No folders in here.</p>}
          {folders.map((name) => (
            <button key={name} type="button" className={`picker-item ${name.startsWith(".") ? "is-hidden" : ""}`} onClick={() => open(name)}>
              <FolderIcon size={16} />
              <span className="picker-item-name">{name}</span>
            </button>
          ))}
        </div>
        <footer className="folder-foot">
          {hiddenCount > 0 ? (
            <label className="folder-hidden-toggle">
              <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
              Show {hiddenCount} hidden
            </label>
          ) : <span />}
          <div className="folder-actions">
            <button type="button" className="button is-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="button" disabled={!listing} onClick={() => listing && onPick(listing.path)}>Use this folder</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
