import { useEffect, useRef, useState } from "react";
import { useSheet } from "./Composer";
import { Segmented } from "./Segmented";
import { ArrowUpIcon, DownloadIcon, PauseIcon, PlayIcon, PlusIcon, RefreshIcon, ScissorsIcon, SettingsIcon } from "./Icons";

// A mock of a sound chat, to see the layout before a music model is wired in.
// Nothing here generates or plays audio; the tracks, waveforms and progress are made up.

type Mode = "song" | "instrumental" | "effect";

const MODES = [
  { value: "song", label: "Song", title: "Vocals sung over music, from your lyrics" },
  { value: "instrumental", label: "Instrumental", title: "Music with no vocals" },
  { value: "effect", label: "Effect", title: "A short sound, like a door or rain" },
] as const;

const LENGTHS: Record<Mode, string[]> = {
  song: ["1:00", "2:00", "3:00", "4:00", "Auto"],
  instrumental: ["0:30", "1:00", "2:00", "4:00"],
  effect: ["0:03", "0:06", "0:12", "0:30"],
};

const MODELS = [
  { id: "ace-step", name: "ACE-Step 1.5", detail: "Songs and instrumentals, up to 10 min, about 4 GB" },
  { id: "stable-audio", name: "Stable Audio Open", detail: "Effects and loops, up to 47 s" },
];

type Take = { id: string; title: string; seconds: number; seed: number; progress?: number };
type Turn = { mode: Mode; prompt: string; length: string; lyrics?: string; model: string; takes: Take[] };

const TURNS: Turn[] = [
  {
    mode: "instrumental",
    prompt: "Lo-fi hip hop, dusty drums, warm Rhodes, rain on the window, 80 bpm",
    length: "2:00",
    model: "ACE-Step 1.5",
    takes: [
      { id: "a", title: "Rainy Rhodes", seconds: 121, seed: 41872 },
      { id: "b", title: "Rainy Rhodes (take 2)", seconds: 118, seed: 90311 },
    ],
  },
  {
    mode: "effect",
    prompt: "Old wooden door creaks open slowly, small room",
    length: "0:06",
    model: "Stable Audio Open",
    takes: [{ id: "c", title: "Door creak", seconds: 6, seed: 5520 }],
  },
  {
    mode: "song",
    prompt: "Upbeat indie pop, female vocals, jangly guitars, summer",
    length: "3:00",
    lyrics: "[verse]\nWe drove out past the water tower\nWindows down for half an hour\n[chorus]\nAnd it's all gold, all gold tonight…",
    model: "ACE-Step 1.5",
    takes: [
      { id: "d", title: "All Gold", seconds: 184, seed: 1207 },
      { id: "e", title: "All Gold (take 2)", seconds: 180, seed: 77345, progress: 0.64 },
    ],
  },
];

const BARS = 72;

/** Bar heights from 0.15 to 1, the same every time for a seed. */
function waveform(seed: number) {
  let x = seed;
  return Array.from({ length: BARS }, (_, i) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    const swell = 0.55 + 0.45 * Math.sin((i / BARS) * Math.PI);
    return 0.15 + 0.85 * swell * (0.35 + 0.65 * (x / 2147483648));
  });
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function TrackCard({ take, playing, onPlay }: { take: Take; playing: boolean; onPlay: (on: boolean) => void }) {
  const bars = useRef(waveform(take.seed)).current;
  const [at, setAt] = useState(0);
  const generating = take.progress !== undefined;

  // Plays at ten times speed, so a mock track gets somewhere while you watch.
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setAt((a) => {
        if (a + 1 < take.seconds) return a + 1;
        onPlay(false);
        return 0;
      });
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, take.seconds]);

  if (generating) {
    return (
      <div className="sound-track is-generating">
        <div className="sound-track-head">
          <span className="sound-play" aria-hidden="true" />
          <strong>{take.title}</strong>
          <span className="sound-time">Making… {Math.round(take.progress! * 100)}%</span>
        </div>
        <div className="sound-wave">
          {bars.map((_, i) => <i key={i} style={{ height: "18%", animationDelay: `${i * 0.03}s` }} className={i / BARS < take.progress! ? "is-done" : ""} />)}
        </div>
      </div>
    );
  }

  return (
    <div className={`sound-track ${playing ? "is-playing" : ""}`}>
      <div className="sound-track-head">
        <button type="button" className="sound-play" aria-label={playing ? "Pause" : "Play"} onClick={() => onPlay(!playing)}>
          {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
        </button>
        <strong>{take.title}</strong>
        <span className="sound-time">{at || playing ? `${clock(at)} / ${clock(take.seconds)}` : clock(take.seconds)}</span>
      </div>
      <div
        className="sound-wave"
        role="slider" aria-label="Position" aria-valuemin={0} aria-valuemax={take.seconds} aria-valuenow={at} tabIndex={0}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setAt(Math.floor(((e.clientX - box.left) / box.width) * take.seconds));
        }}
      >
        {bars.map((h, i) => <i key={i} style={{ height: `${h * 100}%` }} className={i / BARS < at / take.seconds ? "is-played" : ""} />)}
      </div>
      <div className="sound-actions">
        <button type="button" className="icon-button" aria-label="Download" title="Download"><DownloadIcon size={15} /></button>
        <button type="button" className="icon-button" aria-label="More like this" title="More like this"><RefreshIcon size={15} /></button>
        <button type="button" className="icon-button" aria-label="Make it longer" title="Make it longer"><PlusIcon size={15} /></button>
        <button type="button" className="icon-button" aria-label="Redo a section" title="Redo a section"><ScissorsIcon size={15} /></button>
        <span className="stat">seed {take.seed}</span>
      </div>
    </div>
  );
}

function SoundThread() {
  const [playing, setPlaying] = useState<string | null>(null);
  return (
    <div className="thread">
      <div className="thread-inner">
        {TURNS.map((t, i) => (
          <div key={i}>
            <div className="message is-user">
              <div className="bubble">
                {t.prompt}
                {t.lyrics && <pre className="sound-lyrics">{t.lyrics}</pre>}
              </div>
              <span className="voice-time">{MODES.find((m) => m.value === t.mode)!.label} · {t.length}</span>
            </div>
            <div className="message sound-reply">
              {t.takes.map((take) => (
                <TrackCard key={take.id} take={take} playing={playing === take.id} onPlay={(on) => setPlaying(on ? take.id : null)} />
              ))}
              <span className="voice-time">{t.model}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SoundSettings() {
  const [model, setModel] = useState("ace-step");
  const [takes, setTakes] = useState("2");
  const [steps, setSteps] = useState(8);
  return (
    <div className="voice-settings">
      <h3 className="composer-sheet-title">Sound settings</h3>
      <div className="voice-services" role="radiogroup" aria-label="Model">
        {MODELS.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={model === m.id} className={model === m.id ? "is-active" : ""} onClick={() => setModel(m.id)}>
            <strong>{m.name}</strong>
            <small>{m.detail}</small>
          </button>
        ))}
      </div>
      <div className="voice-field">
        <span>Takes per prompt</span>
        <Segmented label="Takes per prompt" value={takes} onChange={setTakes} options={["1", "2", "4"].map((v) => ({ value: v, label: v }))} />
      </div>
      <label className="voice-field">
        <span>Quality</span>
        <input type="range" min={4} max={60} step={1} value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
        <em>{steps} steps</em>
      </label>
      <label className="voice-field">
        <span>Seed</span>
        <input placeholder="Random" />
      </label>
      <label className="voice-field">
        <span>Save as</span>
        <select defaultValue="wav">
          <option value="wav">WAV</option>
          <option value="flac">FLAC</option>
          <option value="mp3">MP3</option>
        </select>
      </label>
    </div>
  );
}

function SoundComposer() {
  const sheet = useSheet();
  const [mode, setMode] = useState<Mode>("song");
  const [length, setLength] = useState("3:00");
  const [prompt, setPrompt] = useState("");
  const [lyrics, setLyrics] = useState("");
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [prompt]);

  const changeMode = (next: Mode) => {
    setMode(next);
    if (!LENGTHS[next].includes(length)) setLength(LENGTHS[next][1]);
  };

  return (
    <div className="composer-wrap">
      <div className="composer-stack" ref={sheet.ref}>
        <div className={`composer-sheet ${sheet.open ? "is-open" : ""}`} aria-hidden={!sheet.open} inert={!sheet.open}>
          <div className="composer-sheet-inner">
            <SoundSettings />
          </div>
        </div>
        <form className="composer voice-composer" onSubmit={(e) => { e.preventDefault(); setPrompt(""); }}>
          <textarea
            ref={promptRef}
            rows={1}
            value={prompt}
            placeholder={mode === "effect" ? "Describe the sound" : "Describe the style: genre, instruments, mood, tempo"}
            onChange={(e) => setPrompt(e.target.value)}
          />
          {/* Lyrics only mean something to a song. */}
          {mode === "song" && (
            <textarea
              className="sound-lyrics-input"
              rows={3}
              value={lyrics}
              placeholder={"Lyrics, with [verse] and [chorus] tags. Leave empty and it writes its own."}
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
            <Segmented label="What to make" value={mode} onChange={changeMode} options={MODES} />
            <div className="topbar-spacer" />
            <select className="sound-length" aria-label="Length" value={length} onChange={(e) => setLength(e.target.value)}>
              {LENGTHS[mode].map((l) => <option key={l} value={l}>{l}</option>)}
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

export function SoundChat() {
  return (
    <>
      <SoundThread />
      <SoundComposer />
    </>
  );
}
