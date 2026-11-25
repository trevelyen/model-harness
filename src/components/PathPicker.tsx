import { useEffect, useMemo, useRef, useState } from "react";
import { errorText } from "../lib/http";
import { AlertIcon, ArrowLeftIcon, FileIcon, FolderIcon, FolderPlusIcon, HomeIcon, SearchIcon, XIcon } from "./Icons";
import { Switch } from "./Switch";
import { Modal } from "./Modal";

type FileEntry = { name: string; size: number; executable: boolean };
type Listing = { path: string; parent: string | null; home: string; folders: string[]; files?: FileEntry[]; selected?: string };
type Row = { kind: "folder"; name: string } | { kind: "file"; name: string; file: FileEntry };

export type PathMode = "folder" | "file";

const size = (bytes: number) =>
  bytes < 1e3 ? `${bytes} B` : bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} KB` : bytes < 1e9 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * A dialog for choosing a folder or a file on this machine, browsed through the daemon.
 * Typing filters the list; the arrow keys and Enter move through it, and Backspace
 * in an empty filter goes up a folder. `executables` only lets you pick files that run.
 */
export function PathPicker({ mode = "folder", initial, executables, onPick, onClose }: {
  mode?: PathMode;
  initial: string;
  executables?: boolean;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(initial.trim() || "~");
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  // The name being typed for a new folder, or null when not making one.
  const [newName, setNewName] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const create = async () => {
    if (!listing || !newName?.trim()) return;
    const res = await fetch("/api/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent: listing.path, name: newName }),
    });
    if (!res.ok) return setError((await errorText(res)).replace(/^\d+: /, ""));
    const { path } = await res.json();
    setNewName(null);
    setDir(path);
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/fs/folders?dir=${encodeURIComponent(dir)}${mode === "file" ? "&files" : ""}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(await errorText(res));
        const next: Listing = await res.json();
        setListing(next);
        setTyped(next.path);
        setError(null);
        setNewName(null);
        setFilter("");
        setSelected(next.selected ?? null);
        setCursor(0);
        filterRef.current?.focus();
      })
      .catch((e: Error) => {
        if (controller.signal.aborted) return;
        // A starting value that isn't a path yet, like a bare "llama-server", opens the home folder.
        if (!listing) return setDir("~");
        setError(e.message.replace(/^\d+: /, ""));
        // A folder that won't open keeps the last good one on screen.
        setTyped(listing.path);
      });
    return () => controller.abort();
  }, [dir]);

  useEffect(() => {
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  const q = filter.trim().toLowerCase();
  const visible = (name: string) => (showHidden || !name.startsWith(".")) && (!q || name.toLowerCase().includes(q));
  const rows = useMemo<Row[]>(
    () => [
      ...(listing?.folders.filter(visible).map((name): Row => ({ kind: "folder", name })) ?? []),
      ...(listing?.files?.filter((f) => visible(f.name)).map((file): Row => ({ kind: "file", name: file.name, file })) ?? []),
    ],
    [listing, showHidden, q],
  );
  const all = [...(listing?.folders ?? []), ...(listing?.files?.map((f) => f.name) ?? [])];
  const hiddenCount = all.filter((n) => n.startsWith(".")).length;

  const join = (name: string) => (listing ? `${listing.path.replace(/\/$/, "")}/${name}` : name);
  const pickable = (file: FileEntry) => !executables || file.executable;
  const activate = (row: Row) => {
    if (row.kind === "folder") return setDir(join(row.name));
    if (!pickable(row.file)) return;
    setSelected(row.name);
  };

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    listRef.current?.querySelector(".is-cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onFilterKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[cursor];
      if (row?.kind === "file" && pickable(row.file)) onPick(join(row.name));
      else if (row) activate(row);
      else if (mode === "folder" && listing) onPick(listing.path);
    } else if (e.key === "Backspace" && !filter && listing?.parent) {
      setDir(listing.parent);
    }
  };

  const chosen = mode === "folder" ? listing?.path : selected && join(selected);
  const noun = mode === "folder" ? "folder" : "file";

  return (
    <Modal className="folder-dialog" label={`Choose a ${noun}`} onDismiss={onClose}>
      <header className="dialog-head">
        <h2>Choose a {noun}</h2>
        <button className="icon-button" aria-label="Close" onClick={onClose}><XIcon size={17} /></button>
      </header>
      <form className="folder-path" onSubmit={(e) => { e.preventDefault(); if (typed.trim()) setDir(typed.trim()); }}>
        <button type="button" className="icon-button" aria-label="Up one folder" title="Up one folder" disabled={!listing?.parent} onClick={() => listing?.parent && setDir(listing.parent)}>
          <ArrowLeftIcon size={16} />
        </button>
        <button type="button" className="icon-button" aria-label="Home folder" title="Home folder" onClick={() => setDir("~")}>
          <HomeIcon size={16} />
        </button>
        <input aria-label="Path" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
      </form>
      <label className="folder-filter">
        <SearchIcon size={15} />
        <input
          ref={filterRef}
          autoFocus
          placeholder={`Filter, or use ↑ ↓ and Enter`}
          value={filter}
          spellCheck={false}
          onChange={(e) => { setFilter(e.target.value); setCursor(0); }}
          onKeyDown={onFilterKey}
        />
      </label>
      {error && <p className="folder-error"><AlertIcon size={15} />{error}</p>}
      <div className="folder-list" ref={listRef} role="listbox" aria-label={`Folders${mode === "file" ? " and files" : ""}`}>
        {newName !== null && (
          <form className="folder-new" onSubmit={(e) => { e.preventDefault(); void create(); }}>
            <FolderPlusIcon size={16} />
            <input
              autoFocus aria-label="New folder name" placeholder="New folder name" value={newName} spellCheck={false}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNewName(null); } }}
            />
            <button type="submit" className="button" disabled={!newName.trim()}>Create</button>
            <button type="button" className="button is-ghost" onClick={() => setNewName(null)}>Cancel</button>
          </form>
        )}
        {listing && rows.length === 0 && newName === null && (
          <p className="picker-note">{q ? "Nothing matches." : mode === "file" ? "Empty folder." : "No folders in here."}</p>
        )}
        {rows.map((row, i) => {
          const off = row.kind === "file" && !pickable(row.file);
          const classes = [
            "picker-item",
            row.name.startsWith(".") && "is-hidden",
            i === cursor && "is-cursor",
            row.kind === "file" && row.name === selected && "is-active",
            off && "is-disabled",
          ].filter(Boolean).join(" ");
          return (
            <button
              key={`${row.kind}:${row.name}`}
              type="button"
              role="option"
              aria-selected={row.kind === "file" && row.name === selected}
              className={classes}
              disabled={off}
              title={off ? "Not a program that can run" : undefined}
              onMouseEnter={() => setCursor(i)}
              onClick={() => activate(row)}
              onDoubleClick={() => row.kind === "file" && !off && onPick(join(row.name))}
            >
              {row.kind === "folder" ? <FolderIcon size={16} /> : <FileIcon size={16} />}
              <span className="picker-item-name">{row.name}</span>
              {row.kind === "file" && <span className="picker-item-detail">{size(row.file.size)}</span>}
            </button>
          );
        })}
      </div>
      <footer className="folder-foot">
        <div className="folder-foot-start">
          <button type="button" className="button is-ghost" title="New folder here" disabled={!listing || newName !== null} onClick={() => { setNewName(""); setError(null); }}>
            New folder
          </button>
          {hiddenCount > 0 && (
            <label className="folder-hidden-toggle">
              <Switch small on={showHidden} onChange={setShowHidden} />
              Show {hiddenCount} hidden
            </label>
          )}
        </div>
        <div className="folder-actions">
          <button type="button" className="button is-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="button" disabled={!chosen} title={chosen || undefined} onClick={() => chosen && onPick(chosen)}>
            Use this {noun}
          </button>
        </div>
      </footer>
    </Modal>
  );
}

/** A text box for a path, with a button that opens the picker. Typing still works. */
export function PathInput({ value, onChange, mode = "folder", placeholder, executables }: {
  value: string;
  onChange: (path: string) => void;
  mode?: PathMode;
  placeholder?: string;
  executables?: boolean;
}) {
  const [browsing, setBrowsing] = useState(false);
  return (
    <div className="folder-input">
      <input placeholder={placeholder} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="icon-button" aria-label={`Browse for a ${mode}`} title="Browse" onClick={() => setBrowsing(true)}>
        {mode === "folder" ? <FolderIcon size={16} /> : <FileIcon size={16} />}
      </button>
      {browsing && (
        <PathPicker
          mode={mode}
          initial={value}
          executables={executables}
          onClose={() => setBrowsing(false)}
          onPick={(path) => {
            onChange(path);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}
