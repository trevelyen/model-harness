// Saves app data as plain JSON files in the repo's data/ folder:
//   data/state.json        providers, harnesses and the current selection
//   data/chats/<id>.json   one file per conversation
// API keys never reach this folder; the browser keeps them.
// A copy of the settings, keys included, is mirrored to ~/.model-harness/state.json
// so a wiped or fresh data/ folder can be restored from it.
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const DATA_DIR = resolve(process.env.MODEL_HARNESS_DATA || "data");
const CHATS_DIR = join(DATA_DIR, "chats");
const STATE_FILE = join(DATA_DIR, "state.json");
const BACKUP_DIR = join(homedir(), ".model-harness");
const BACKUP_FILE = join(BACKUP_DIR, "state.json");
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSafeId(id: string) {
  return SAFE_ID.test(id);
}

// Write to a temp file and rename, so a crash never leaves half a file.
async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, path);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function readAll() {
  let state = await readJson(STATE_FILE);
  let names: string[] = [];
  try {
    names = (await readdir(CHATS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    // No chats saved yet.
  }
  const conversations = (await Promise.all(names.map((n) => readJson(join(CHATS_DIR, n))))).filter(Boolean);
  if (!state) state = await restore();
  return { state, conversations };
}

export function writeState(value: unknown) {
  return writeJson(STATE_FILE, value);
}

/** The full settings from the browser, API keys included. Never read back into the repo. */
export function writeBackup(value: unknown) {
  return writeJson(BACKUP_FILE, value);
}

/**
 * data/ is gone or empty, but the home backup has settings: put them back, so
 * providers, harnesses and the model choice survive a wiped data folder.
 */
async function restore() {
  const backup = (await readJson(BACKUP_FILE)) as { providers?: unknown[] } | null;
  if (!backup || !Array.isArray(backup.providers) || backup.providers.length === 0) return null;
  await writeJson(STATE_FILE, backup).catch(() => {});
  return backup;
}

export function writeChat(id: string, value: unknown) {
  return writeJson(join(CHATS_DIR, `${id}.json`), value);
}

export function deleteChat(id: string) {
  return rm(join(CHATS_DIR, `${id}.json`), { force: true });
}
