// Sound chats: asks the daemon's sound models (server/sound.ts) for tracks and
// saves each turn in the chat, like any other message.
import { ndjson, errorText } from "../lib/http";
import { titleFrom } from "../state/chat";
import { getState, uid, updateConversation, updateMessage, type Message, type SoundMode, type SoundSettings, type SoundTrack } from "../state/store";

type SoundEvent =
  | { type: "status"; text: string }
  | { type: "progress"; value: number }
  | { type: "done"; tracks: SoundTrack[] }
  | { type: "error"; message: string };

export const SOUND_MODELS = {
  "ace-step": { name: "ACE-Step 1.5", detail: "Fast, about 14 GB of GPU memory, MIT licence", longest: 600 },
  // YuE2 decides a song's length from its lyrics, so 0, letting it choose, is all it takes.
  yue: { name: "YuE2", detail: "Stronger vocals, about 6 GB, picks its own length, non-commercial", longest: 0 },
  effects: { name: "Stable Audio Open", detail: "Effects and loops, up to 47 s", longest: 47 },
} as const;

export type SoundModelId = keyof typeof SOUND_MODELS;

/** The model a mode uses: songs the one picked in settings, the rest their own. */
export function modelFor(mode: SoundMode, settings: SoundSettings): SoundModelId {
  return mode === "song" ? settings.songModel : mode === "instrumental" ? "ace-step" : "effects";
}

/** Where a saved track is served from. */
export const trackUrl = (conversationId: string, file: string) => `/api/sound/files/${conversationId}/${file}`;

/** Adds a turn asking for `prompt` to the chat, then makes its tracks. */
export async function makeSound(conversationId: string, ask: { prompt: string; mode: SoundMode; seconds: number; lyrics?: string; seed?: number; takes?: number }) {
  const settings = getState().sound;
  const model = modelFor(ask.mode, settings);
  const takes = ask.takes ?? settings.takes;
  const turn = { mode: ask.mode, seconds: ask.seconds, model: SOUND_MODELS[model].name, lyrics: ask.mode === "song" ? ask.lyrics || undefined : undefined };
  const user: Message = { id: uid(), role: "user", content: ask.prompt, sound: turn };
  const reply: Message = {
    id: uid(), role: "assistant", content: "", streaming: true, status: "Waiting", startedAt: Date.now(),
    sound: { ...turn, lyrics: undefined, takes, tracks: [], progress: 0 },
  };
  updateConversation(conversationId, (c) => ({
    ...c,
    title: c.messages.length === 0 ? titleFrom(ask.prompt) : c.title,
    messages: [...c.messages, user, reply],
    updatedAt: Date.now(),
  }));
  const update = (change: (m: Message) => Message) => updateMessage(conversationId, reply.id, change);

  try {
    const res = await fetch("/api/sound/make", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: conversationId, model, mode: ask.mode, prompt: ask.prompt, lyrics: turn.lyrics, seconds: ask.seconds,
        takes, steps: settings.steps, seed: ask.seed ?? settings.seed, format: settings.format,
      }),
    });
    if (!res.ok || !res.body) throw new Error(await errorText(res));
    for await (const event of ndjson<SoundEvent>(res.body)) {
      if (event.type === "status") update((m) => ({ ...m, status: event.text }));
      else if (event.type === "progress") update((m) => ({ ...m, status: "Making", sound: { ...m.sound!, progress: event.value } }));
      else if (event.type === "done") update((m) => ({ ...m, status: undefined, sound: { ...m.sound!, tracks: event.tracks, progress: undefined } }));
      else update((m) => ({ ...m, error: event.message }));
    }
  } catch (error) {
    update((m) => ({ ...m, error: (error as Error).message }));
  } finally {
    update((m) => ({ ...m, streaming: false, status: undefined, finishedAt: Date.now() }));
  }
}

/** Unloads the sound model, giving its GPU memory back. */
export async function stopSoundServer() {
  await fetch("/api/sound/stop", { method: "POST" });
}
