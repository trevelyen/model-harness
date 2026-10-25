// Saves app data as plain JSON files in the repo's data/ folder:
//   data/state.json        providers, harnesses and the current selection
//   data/chats/<id>.json   one file per conversation
// API keys never reach this folder; the browser keeps them.
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DATA_DIR = resolve(process.env.MODEL_HARNESS_DATA || "data");
const CHATS_DIR = join(DATA_DIR, "chats");
const STATE_FILE = join(DATA_DIR, "state.json");
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
  const state = await readJson(STATE_FILE);
  let names: string[] = [];
  try {
    names = (await readdir(CHATS_DIR)).filter((n) => n.endsWith(".json"));
  } catch {
    // No chats saved yet.
  }
  const conversations = (await Promise.all(names.map((n) => readJson(join(CHATS_DIR, n))))).filter(Boolean);
  return { state, conversations };
}

export function writeState(value: unknown) {
  return writeJson(STATE_FILE, value);
}

export function writeChat(id: string, value: unknown) {
  return writeJson(join(CHATS_DIR, `${id}.json`), value);
}

export function deleteChat(id: string) {
  return rm(join(CHATS_DIR, `${id}.json`), { force: true });
}
