import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSheet } from "./Composer";
import { Segmented } from "./Segmented";
import { AlertIcon, ArrowUpIcon, DownloadIcon, PauseIcon, PlayIcon, RefreshIcon, SettingsIcon } from "./Icons";
import { updateSound, useStore, type Conversation, type Message, type SoundMode, type SoundTrack } from "../state/store";
import { makeSound, modelFor, SOUND_MODELS, trackUrl } from "../sound/client";

const MODES = [
  { value: "song", label: "Song", title: "Vocals sung over music, from your lyrics" },
  { value: "instrumental", label: "Instrumental", title: "Music with no vocals" },
  { value: "effect", label: "Effect", title: "A short sound, like a door or rain" },
] as const;

const MODE_LABEL = Object.fromEntries(MODES.map((m) => [m.value, m.label])) as Record<SoundMode, string>;

/** The lengths each mode offers, in seconds. 0 lets the model choose from the lyrics. */
const LENGTHS: Record<SoundMode, number[]> = {
  song: [0, 60, 120, 180, 240],
  instrumental: [30, 60, 120, 180, 240],
  effect: [3, 6, 12, 30, 47],
};

const BARS = 90;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const lengthLabel = (s: number) => (s === 0 ? "Auto" : s < 60 ? `${s} s` : clock(s));

// Each track's loudness in BARS slices, worked out once from its file.
const peaks = new Map<string, Promise<number[]>>();

function loadPeaks(url: string) {
  if (!peaks.has(url)) {
    peaks.set(url, (async () => {
      const data = await (await fetch(url)).arrayBuffer();
      const context = new OfflineAudioContext(1, 1, 44_100);
      const samples = (await context.decodeAudioData(data)).getChannelData(0);
      const size = Math.floor(samples.length / BARS);
      const bars = Array.from({ length: BARS }, (_, i) => {
        let top = 0;
        for (let j = i * size; j < (i + 1) * size; j += 16) top = Math.max(top, Math.abs(samples[j]));
        return top;
      });
      const loudest = Math.max(...bars, 1e-6);
      return bars.map((b) => 0.08 + 0.92 * (b / loudest));
    })().catch(() => Array(BARS).fill(0.3)));
  }
  return peaks.get(url)!;
}

// Only one track plays at a time: starting one pauses the last.
let playing: HTMLAudioElement | null = null;

function TrackCard({ conversationId, track, take, onMore }: { conversationId: string; track: SoundTrack; take: number; onMore: () => void }) {
  const url = trackUrl(conversationId, track.file);
  const audio = useRef<HTMLAudioElement>(null);
  const [bars, setBars] = useState<number[] | null>(null);
  const [at, setAt] = useState(0);
  const [on, setOn] = useState(false);

  useEffect(() => {
    let live = true;
    void loadPeaks(url).then((b) => live && setBars(b));
    return () => void (live = false);
  }, [url]);

  const toggle = () => {
    const el = audio.current!;
    if (el.paused) {
      if (playing && playing !== el) playing.pause();
      playing = el;
      void el.play();
    } else el.pause();
  };

  return (
    <div className={`sound-track ${on ? "is-playing" : ""}`}>
      <audio
        ref={audio} src={url} preload="metadata"
        onPlay={() => setOn(true)} onPause={() => setOn(false)} onEnded={() => setAt(0)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)}
      />
      <div className="sound-track-head">
        <button type="button" className="sound-play" aria-label={on ? "Pause" : "Play"} onClick={toggle}>
          {on ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <strong>Take {take + 1}</strong>
        <span className="sound-time">{at || on ? `${clock(at)} / ${clock(track.seconds)}` : clock(track.seconds)}</span>
      </div>
      <div
        className="sound-wave"
        role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={track.seconds} aria-valuenow={Math.floor(at)} tabIndex={0}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          audio.current!.currentTime = ((e.clientX - box.left) / box.width) * track.seconds;
        }}
        onKeyDown={(e) => {
          const step = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
          if (step) audio.current!.currentTime = Math.min(Math.max(at + step, 0), track.seconds);
        }}
      >
        {(bars ?? Array(BARS).fill(0.08)).map((h, i) => (
          <i key={i} style={{ height: `${h * 100}%` }} className={i / BARS < at / track.seconds ? "is-played" : ""} />
        ))}
      </div>
      <div className="sound-actions">
        <a className="icon-button" href={url} download aria-label="Download" title="Download"><DownloadIcon size={15} /></a>
        <button type="button" className="icon-button" aria-label="Make more like this" title="Make more like this" onClick={onMore}><RefreshIcon size={15} /></button>
        <span className="stat" title="Ask for this seed in the settings to make it again">seed {track.seed}</span>
      </div>
    </div>
  );
}

/** A reply still being made: one card per take, filling as it goes. */
function Making({ message }: { message: Message }) {
  const progress = message.sound?.progress ?? 0;
  return (
    <>
      {Array.from({ length: message.sound?.takes ?? 1 }, (_, take) => (
        <div key={take} className="sound-track is-generating">
          <div className="sound-track-head">
            <span className="sound-play" aria-hidden="true" />
            <strong>Take {take + 1}</strong>
            <span className="sound-time">{progress > 0 ? `${Math.round(progress * 100)}%` : ""}</span>
          </div>
          <div className="sound-wave">
            {Array.from({ length: BARS }, (_, i) => (
              <i key={i} style={{ height: "14%", animationDelay: `${i * 0.03}s` }} className={i / BARS < progress ? "is-done" : ""} />
            ))}
          </div>
        </div>
      ))}
      <span className="voice-time">{message.status ?? "Making"}…</span>
    </>
  );
}

function SoundThread({ conversation }: { conversation: Conversation }) {
  const scroller = useRef<HTMLDivElement>(null);
  const messages = conversation.messages;

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  if (!messages.length) {
    return (
      <div className="thread is-empty">
        <div className="welcome">
          <h1>What should it make?</h1>
        </div>
      </div>
    );
  }

  return (
    <div className="thread" ref={scroller}>
      <div className="thread-inner">
        {messages.map((m, i) => {
          if (m.role === "user") {
            return (
              <div key={m.id} className="message is-user">
                <div className="bubble">
                  {m.content}
                  {m.sound?.lyrics && <pre className="sound-lyrics">{m.sound.lyrics}</pre>}
                </div>
                {m.sound && <span className="voice-time">{MODE_LABEL[m.sound.mode]} - {lengthLabel(m.sound.seconds)}</span>}
              </div>
            );
          }
          const ask = messages[i - 1];
          const again = () =>
            ask?.sound && void makeSound(conversation.id, { prompt: ask.content, mode: ask.sound.mode, seconds: ask.sound.seconds, lyrics: ask.sound.lyrics });
          const tracks = m.sound?.tracks ?? [];
          return (
            <div key={m.id} className="message sound-reply">
              {m.streaming ? (
                <Making message={m} />
              ) : (
                <>
                  {tracks.map((t, take) => <TrackCard key={t.file} conversationId={conversation.id} track={t} take={take} onMore={again} />)}
                  {m.error ? (
                    <div className="sound-error">
                      <AlertIcon size={15} />
                      <p>{m.error}</p>
                      <button type="button" className="icon-button" aria-label="Try again" title="Try again" onClick={again}><RefreshIcon size={15} /></button>
                    </div>
                  ) : !tracks.length && (
                    <div className="sound-error">
                      <p>Stopped before it finished, when the page closed.</p>
                      <button type="button" className="icon-button" aria-label="Try again" title="Try again" onClick={again}><RefreshIcon size={15} /></button>
                    </div>
                  )}
                  {m.sound && <span className="voice-time">{m.sound.model}{m.startedAt && m.finishedAt ? ` - ${Math.round((m.finishedAt - m.startedAt) / 1000)} s` : ""}</span>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SoundSettings() {
  const sound = useStore((s) => s.sound);
  return (
    <div className="voice-settings">
      <h3 className="composer-sheet-title">Sound settings</h3>
      <div className="voice-field">
        <span>Songs are made by</span>
      </div>
      <div className="voice-services" role="radiogroup" aria-label="Song model">
        {(["ace-step", "yue"] as const).map((id) => (
          <button key={id} type="button" role="radio" aria-checked={sound.songModel === id} className={sound.songModel === id ? "is-active" : ""} onClick={() => updateSound({ songModel: id })}>
            <strong>{SOUND_MODELS[id].name}</strong>
            <small>{SOUND_MODELS[id].detail}</small>
          </button>
        ))}
      </div>
      <p className="composer-sheet-note">Instrumentals are made by ACE-Step 1.5, and effects by Stable Audio Open.</p>
      <div className="voice-field">
        <span>Takes each time</span>
        <Segmented label="Takes each time" value={String(sound.takes)} onChange={(v) => updateSound({ takes: Number(v) })} options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))} />
      </div>
      <label className="voice-field">
        <span>Steps</span>
        <input type="range" min={0} max={120} step={1} value={sound.steps ?? 0} onChange={(e) => updateSound({ steps: Number(e.target.value) || undefined })} />
        <em>{sound.steps ?? "Model's own"}</em>
      </label>
      <label className="voice-field">
        <span>Seed</span>
        <input
          inputMode="numeric" placeholder="New each time" value={sound.seed ?? ""}
          onChange={(e) => {
            const seed = parseInt(e.target.value, 10);
            updateSound({ seed: Number.isNaN(seed) ? undefined : seed });
          }}
        />
      </label>
      <label className="voice-field">
        <span>Save as</span>
        <select value={sound.format} onChange={(e) => updateSound({ format: e.target.value as "wav" | "flac" })}>
          <option value="wav">WAV</option>
          <option value="flac">FLAC</option>
        </select>
      </label>
    </div>
  );
}

function SoundComposer({ conversationId }: { conversationId: string }) {
  const sheet = useSheet();
  const sound = useStore((s) => s.sound);
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const mode = sound.mode;
  const longest = SOUND_MODELS[modelFor(mode, sound)].longest;
  const lengths = LENGTHS[mode].filter((l) => l <= longest);
  const seconds = lengths.includes(sound.seconds[mode]) ? sound.seconds[mode] : lengths[1] ?? lengths[0];

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [prompt]);

  const submit = () => {
    if (!prompt.trim()) return;
    void makeSound(conversationId, { prompt: prompt.trim(), mode, seconds, lyrics: lyrics.trim() });
    setPrompt("");
    setLyrics("");
  };

  return (
    <div className="composer-wrap">
      <div className="composer-stack" ref={sheet.ref}>
        <div className={`composer-sheet ${sheet.open ? "is-open" : ""}`} aria-hidden={!sheet.open} inert={!sheet.open}>
          <div className="composer-sheet-inner">
            <SoundSettings />
          </div>
        </div>
        <form className="composer voice-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <textarea
            ref={promptRef}
            rows={1}
            value={prompt}
            placeholder={mode === "effect" ? "Describe the sound" : "Describe the style: genre, instruments, mood, tempo"}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
          />
          {/* Lyrics only mean something to a song. */}
          {mode === "song" && (
            <textarea
              className="sound-lyrics-input"
              rows={3}
              value={lyrics}
              placeholder="Lyrics, with [verse] and [chorus] tags"
              onChange={(e) => setLyrics(e.target.value)}
            />
          )}
          <div className="voice-bar">
            <button
              type="button"
              className={`icon-button ${sheet.open ? "is-active" : ""}`}
              aria-label="Sound settings"
              aria-expanded={sheet.open}
              onClick={() => sheet.setOpen((o) => !o)}
            >
              <SettingsIcon size={16} />
            </button>
            <Segmented label="What to make" value={mode} onChange={(next) => updateSound({ mode: next })} options={MODES} />
            <div className="topbar-spacer" />
            <select
              className="sound-length" aria-label="Length" value={seconds}
              onChange={(e) => updateSound({ seconds: { ...sound.seconds, [mode]: Number(e.target.value) } })}
            >
              {lengths.map((l) => <option key={l} value={l}>{lengthLabel(l)}</option>)}
            </select>
            <button type="submit" className="send" aria-label="Make" disabled={!prompt.trim()}>
              <ArrowUpIcon size={18} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SoundChat({ conversation }: { conversation: Conversation }) {
  return (
    <>
      <SoundThread conversation={conversation} />
      <SoundComposer conversationId={conversation.id} />
    </>
  );
}
