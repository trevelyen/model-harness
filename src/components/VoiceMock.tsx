import { useEffect, useRef, useState } from "react";
import { useSheet } from "./Composer";
import { ArrowUpIcon, MicIcon, MicOffIcon, SettingsIcon, StopIcon } from "./Icons";

// A mock of a voice chat, to see the layout before speech-testing's services are wired in.
// Nothing here records or plays audio; the transcript and meters are made up.

const SERVICES = [
  { id: "cascade", name: "Cascade", detail: "Whisper, your language model, Chatterbox" },
  { id: "haru", name: "Haru 4B", detail: "Full duplex, runs on this GPU" },
];

type Turn = { who: "you" | "model"; text: string; time: string; heard?: string; typed?: boolean };

const TURNS: Turn[] = [
  { who: "you", text: "Hey, can you hear me okay?", time: "0:02" },
  { who: "model", text: "Loud and clear. What's on your mind?", time: "0:04" },
  { who: "you", text: "I'm trying to pick a name for a boat.", time: "0:09" },
  {
    who: "model",
    heard: "Ooh, fun. [chuckle] Something classic, like the Wandering",
    text: " Albatross, or something sillier, like Seas the Day?",
    time: "0:12",
  },
  { who: "you", text: "Sillier. Definitely sillier.", time: "0:15" },
  { who: "you", text: "Give me three more.", time: "0:21", typed: true },
];

function Meter({ label, live, speaking }: { label: string; live: boolean; speaking: boolean }) {
  return (
    <div className={`voice-meter ${live ? "is-live" : ""} ${speaking ? "is-speaking" : ""}`}>
      <span>{label}</span>
      <b>
        {Array.from({ length: 5 }, (_, i) => (
          <i key={i} style={{ animationDelay: `${i * -0.17}s` }} />
        ))}
      </b>
    </div>
  );
}

function VoiceSettings({ service, onService }: { service: string; onService: (id: string) => void }) {
  return (
    <div className="voice-settings">
      <h3 className="composer-sheet-title">Voice settings</h3>
      <div className="voice-services" role="radiogroup" aria-label="Service">
        {SERVICES.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={service === s.id} className={service === s.id ? "is-active" : ""} onClick={() => onService(s.id)}>
            <strong>{s.name}</strong>
            <small>{s.detail}</small>
          </button>
        ))}
      </div>
      <label className="voice-field">
        <span>Voice</span>
        <select defaultValue="maya">
          <option value="maya">Maya (0:42 clip)</option>
          <option value="dad">Dad (1:10 clip)</option>
          <option value="add">Add a voice…</option>
        </select>
      </label>
      {service === "cascade" && (
        <>
          <label className="voice-field">
            <span>Pause before it answers</span>
            <input type="range" min={0.2} max={1.5} step={0.1} defaultValue={0.6} />
            <em>0.6 s</em>
          </label>
          <div className="voice-checks">
            <label><input type="checkbox" defaultChecked /> Fillers</label>
            <label><input type="checkbox" defaultChecked /> Sounds</label>
            <label><input type="checkbox" /> Thinks before it answers</label>
          </div>
        </>
      )}
    </div>
  );
}

export function VoiceThread({ live }: { live: boolean }) {
  if (!live) {
    return (
      <div className="thread is-empty">
        <div className="welcome voice-welcome">
          <div className="voice-orb" aria-hidden="true" />
          <h1>Start talking</h1>
        </div>
      </div>
    );
  }
  return (
    <div className="thread">
      <div className="thread-inner voice-transcript">
        {TURNS.map((t, i) =>
          t.who === "you" ? (
            <div key={i} className="message is-user">
              <div className="bubble">{t.text}</div>
              <span className="voice-time">{t.typed ? `Typed · ${t.time}` : t.time}</span>
            </div>
          ) : (
            <div key={i} className="message voice-reply">
              <p>
                {t.heard ?? t.text}
                {t.heard && <span className="voice-unheard" title="Cut off. The model only knows you heard the first part.">{t.text}</span>}
              </p>
              <span className="voice-time">{t.heard ? `Cut off · ${t.time}` : t.time}</span>
            </div>
          ),
        )}
        <div className="message voice-reply is-live">
          <p>Okay, okay. Knot Too Shabby. Pier Pressure. And</p>
          <span className="voice-time">Speaking…</span>
        </div>
      </div>
    </div>
  );
}

export function VoiceComposer({ live, onLive }: { live: boolean; onLive: (live: boolean) => void }) {
  const sheet = useSheet();
  const [mic, setMic] = useState(true);
  const [service, setService] = useState("cascade");
  const [line, setLine] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [line]);

  return (
    <div className="composer-wrap">
      <div className="composer-stack" ref={sheet.ref}>
        <div className={`composer-sheet ${sheet.open ? "is-open" : ""}`} aria-hidden={!sheet.open} inert={!sheet.open}>
          <div className="composer-sheet-inner">
            <VoiceSettings service={service} onService={setService} />
          </div>
        </div>
        <form className="composer voice-composer" onSubmit={(e) => { e.preventDefault(); setLine(""); }}>
          {/* Typed while live, it's a line for the model to hear; otherwise a text message. */}
          <textarea
            ref={textRef}
            rows={1}
            value={line}
            placeholder="Message"
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setLine("");
              }
            }}
          />
          <div className="voice-bar">
            <button
              type="button"
              className={`icon-button ${sheet.open ? "is-active" : ""}`}
              aria-label="Voice settings"
              aria-expanded={sheet.open}
              onClick={() => sheet.setOpen((o) => !o)}
            >
              <SettingsIcon size={16} />
            </button>
            <button type="button" className={`think-toggle ${mic ? "is-on" : ""}`} aria-pressed={mic} onClick={() => setMic((m) => !m)}>
              {mic ? <MicIcon size={15} /> : <MicOffIcon size={15} />}
              {mic ? "Mic on" : "Mic off"}
            </button>
            <div className="voice-meters">
              <Meter label="You" live={live && mic} speaking={false} />
              <Meter label="Model" live={live} speaking={live} />
            </div>
            <span className="voice-status">{live ? "Speaking" : "Ready"}</span>
            {line.trim() && (
              <button type="submit" className="send" aria-label="Send">
                <ArrowUpIcon size={18} />
              </button>
            )}
            <button
              type="button"
              className={`voice-start ${live ? "is-live" : ""}`}
              aria-label={live ? "End" : "Start"}
              onClick={() => onLive(!live)}
            >
              {live ? <StopIcon size={18} /> : <MicIcon size={18} />}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function VoiceChat() {
  const [live, setLive] = useState(false);
  return (
    <>
      <VoiceThread live={live} />
      <VoiceComposer live={live} onLive={setLive} />
    </>
  );
}
