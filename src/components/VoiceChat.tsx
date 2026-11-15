import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getState, uid, updateConversation, updateMessage, updateVoice, useStore, type Conversation, type Message } from "../state/store";
import { titleFrom } from "../state/chat";
import {
  addVoice, listServices, listVoices, recordClip, removeVoice, voiceAudioUrl, voiceLlm, VoiceSession,
  type VoiceClip, type VoiceField, type VoiceService,
} from "../voice/client";
import { ComposerSheet, MessageBox, SheetButton, useSheet } from "./Composer";
import { Range } from "./Range";
import { Switch } from "./Switch";
import { ArrowUpIcon, MicIcon, MicOffIcon, StopIcon } from "./Icons";

// A voice chat: a conversation with one of the voice server's services, kept
// in the chat like any other. What the person says (as the service heard it)
// and types become their messages; what the service says becomes its replies.

// Filled from the model picked at the top of the app, so they aren't shown.
const HIDDEN_FIELDS = new Set(["llm_url", "llm_model", "llm_key"]);
// A short line under each service's name in the sheet.
const DETAILS: Record<string, string> = {
  cascade: "Whisper, your language model, Chatterbox",
  haru: "Full duplex, runs on this GPU",
};
// The service's words after a pause this long start a new reply.
const PARAGRAPH_GAP = 2500;

type Phase = "idle" | "starting" | "live";

function useVoiceSettings(service: VoiceService | undefined) {
  const voice = useStore((s) => s.voice);
  const stored = service ? voice.values[service.id] ?? {} : {};
  const values: Record<string, unknown> = {};
  for (const field of service?.fields ?? []) values[field.key] = field.key in stored ? stored[field.key] : field.default;
  const set = (key: string, value: unknown) =>
    service && updateVoice((v) => ({ values: { ...v.values, [service.id]: { ...v.values[service.id], [key]: value } } }));
  return { voice, values, set };
}

/** Bars that follow how loud one side is. Updated outside React, every frame. */
function Meter({ label, barsRef }: { label: string; barsRef: React.RefObject<HTMLElement | null> }) {
  return (
    <div className="voice-meter">
      <span>{label}</span>
      <b ref={barsRef}>
        {Array.from({ length: 5 }, (_, i) => <i key={i} />)}
      </b>
    </div>
  );
}

// Each bar's share of the level, so the five don't move as one.
const BAR_SHAPE = [0.55, 0.85, 1, 0.75, 0.5];

function drawBars(bars: HTMLElement | null, level: number) {
  if (!bars) return;
  bars.classList.toggle("is-active", level > 0.04);
  [...bars.children].forEach((bar, i) => ((bar as HTMLElement).style.height = `${4 + Math.min(1, level * 2.2) * 14 * BAR_SHAPE[i]}px`));
}

function VoicePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [clips, setClips] = useState<VoiceClip[]>([]);
  const [note, setNote] = useState("");
  const [recording, setRecording] = useState<{ stop: () => Promise<Blob> } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const player = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    listVoices().then(setClips, (e: Error) => setNote(e.message));
  }, []);

  const guarded = async (work: () => Promise<void>) => {
    setNote("");
    try {
      await work();
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const add = (name: string, audio: Blob) =>
    guarded(async () => {
      const clip = await addVoice(name, audio);
      setClips(await listVoices());
      onChange(clip.id);
    });

  return (
    <div className="voice-field is-voice">
      <span>Voice</span>
      <div className="voice-picker">
        <select value={clips.some((c) => c.id === value) ? value : ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">A voice of its own</option>
          {clips.map((c) => (
            <option key={c.id} value={c.id}>{`${c.id} (${c.seconds.toFixed(1)} s)`}</option>
          ))}
        </select>
        <div className="voice-picker-actions">
          <button
            type="button"
            disabled={!value}
            onClick={() => {
              player.current?.pause();
              player.current = new Audio(voiceAudioUrl(value));
              void player.current.play();
            }}
          >
            Play
          </button>
          <button
            type="button"
            disabled={!value}
            onClick={() => guarded(async () => {
              await removeVoice(value);
              setClips(await listVoices());
              onChange("");
            })}
          >
            Delete
          </button>
          <button type="button" onClick={() => file.current?.click()}>Upload</button>
          <button
            type="button"
            className={recording ? "is-recording" : ""}
            onClick={() => guarded(async () => {
              if (!recording) {
                setSeconds(0);
                setRecording(await recordClip(setSeconds));
                return;
              }
              const clip = await recording.stop();
              setRecording(null);
              await add("recording", clip);
            })}
          >
            {recording ? `Stop (${seconds.toFixed(0)} s)` : "Record"}
          </button>
        </div>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void add(picked.name.replace(/\.[^.]+$/, ""), picked);
            e.target.value = "";
          }}
        />
        {note && <small className="voice-note">{note}</small>}
      </div>
    </div>
  );
}

function FieldControl({ field, value, onChange }: { field: VoiceField; value: unknown; onChange: (value: unknown) => void }) {
  switch (field.type) {
    case "voice":
      return <VoicePicker value={String(value ?? "")} onChange={onChange} />;
    case "number":
      return (
        <label className="voice-field" title={field.help}>
          <span>{field.label}</span>
          <Range min={field.min} max={field.max} step={field.step} value={Number(value)} onChange={onChange} />
          <em>{Number(value).toFixed(field.step < 0.1 ? 2 : 1)}</em>
        </label>
      );
    case "choice":
      return (
        <label className="voice-field" title={field.help}>
          <span>{field.label}</span>
          <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
            {field.options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
      );
    case "text":
      return (
        <label className={`voice-field ${field.multiline ? "is-text" : ""}`} title={field.help}>
          <span>{field.label}</span>
          {field.multiline ? (
            <textarea rows={4} value={String(value)} onChange={(e) => onChange(e.target.value)} />
          ) : (
            <input value={String(value)} onChange={(e) => onChange(e.target.value)} />
          )}
        </label>
      );
    case "toggle":
      return null; // Drawn together, in VoiceSettings.
  }
}

function VoiceSettings({ services, service, values, onService, onChange }: {
  services: VoiceService[];
  service: VoiceService | undefined;
  values: Record<string, unknown>;
  onService: (id: string) => void;
  onChange: (key: string, value: unknown) => void;
}) {
  const fields = (service?.fields ?? []).filter((f) => !HIDDEN_FIELDS.has(f.key));
  const toggles = fields.filter((f) => f.type === "toggle");
  return (
    <div className="voice-settings">
      <h3 className="composer-sheet-title">Voice settings</h3>
      <div className="voice-services" role="radiogroup" aria-label="Service">
        {services.map((s) => (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={service?.id === s.id}
            className={service?.id === s.id ? "is-active" : ""}
            title={s.status.detail}
            onClick={() => onService(s.id)}
          >
            <strong>{s.name}</strong>
            <small>{DETAILS[s.id] ?? s.summary}</small>
          </button>
        ))}
      </div>
      {fields.filter((f) => f.type !== "toggle" && !(f.type === "text" && f.multiline)).map((f) => (
        <FieldControl key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />
      ))}
      {toggles.length > 0 && (
        <div className="voice-checks">
          {toggles.map((f) => (
            <label key={f.key} title={f.help}>
              <Switch small on={values[f.key] === true} onChange={(on) => onChange(f.key, on)} />
              {f.label}
            </label>
          ))}
        </div>
      )}
      {fields.filter((f) => f.type === "text" && f.multiline).map((f) => (
        <FieldControl key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />
      ))}
    </div>
  );
}

/**
 * Progress and errors, floating above the composer so they don't move the page.
 * The last line stays while it fades out, so it doesn't vanish mid-fade.
 */
function Notice({ text, error, hidden }: { text: string; error?: boolean; hidden: boolean }) {
  const [shown, setShown] = useState({ text, error });
  useEffect(() => {
    if (text) setShown({ text, error });
  }, [text, error]);
  return (
    <p
      className={`voice-notice ${text && !hidden ? "is-visible" : ""} ${shown.error ? "is-error" : ""}`}
      role={shown.error ? "alert" : "status"}
      aria-hidden={!text}
    >
      {shown.text}
    </p>
  );
}

function clock(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function VoiceThread({ messages }: { messages: Message[] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const last = messages.at(-1);

  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, last?.content]);

  if (!messages.length) {
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
    <div className="thread" ref={scroller}>
      <div className="thread-inner voice-transcript">
        {messages.map((m) => {
          const at = m.voice ? clock(m.voice.at) : "";
          return m.role === "user" ? (
            <div key={m.id} className="message is-user">
              <div className="bubble">{m.content}</div>
              {at && <span className="voice-time">{m.voice?.typed ? `Typed · ${at}` : at}</span>}
            </div>
          ) : (
            <div key={m.id} className={`message voice-reply ${m.streaming ? "is-live" : ""}`}>
              <p>{m.content.trim()}</p>
              {at && <span className="voice-time">{m.voice?.cutOff ? `Cut off · ${at}` : at}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function VoiceChat({ conversation }: { conversation: Conversation }) {
  const sheet = useSheet();
  const [services, setServices] = useState<VoiceService[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, setStatus] = useState<{ text: string; error?: boolean }>({ text: "Starting the voice server" });
  const [speaking, setSpeaking] = useState(false);
  const [line, setLine] = useState("");
  const youBars = useRef<HTMLElement>(null);
  const modelBars = useRef<HTMLElement>(null);
  const session = useRef<VoiceSession | null>(null);
  // Lines typed before the session was ready, sent once it is.
  const waiting = useRef<string[]>([]);
  // The reply being spoken, and when its last words came, for joining words into replies.
  const reply = useRef<{ id: string; at: number } | null>(null);
  const startedAt = useRef(0);
  // Set when End is pressed while the language model is still loading, before there's a session.
  const cancelled = useRef(false);

  const serviceId = useStore((s) => s.voice.service);
  const service = services.find((s) => s.id === serviceId) ?? services[0];
  const settings = useVoiceSettings(service);
  const mic = settings.voice.mic;
  const id = conversation.id;

  useEffect(() => {
    listServices().then(
      (list) => {
        setServices(list);
        setStatus({ text: "" });
      },
      (e: Error) => setStatus({ text: `The voice server did not start: ${e.message}`, error: true }),
    );
  }, []);

  // Stop talking when the chat closes.
  useEffect(() => () => session.current?.stop(), []);

  const seconds = () => (Date.now() - startedAt.current) / 1000;

  const endReply = useCallback(() => {
    if (reply.current) updateMessage(id, reply.current.id, (m) => ({ ...m, streaming: false }));
    reply.current = null;
  }, [id]);

  const addMessage = useCallback(
    (message: Message) => updateConversation(id, (c) => ({ ...c, messages: [...c.messages, message], updatedAt: Date.now() })),
    [id],
  );

  const userLine = useCallback(
    (text: string, typed: boolean) => {
      endReply();
      addMessage({ id: uid(), role: "user", content: text, voice: { at: seconds(), typed: typed || undefined } });
      // The chat's first words name it.
      updateConversation(id, (c) =>
        c.title.startsWith("New ") && c.messages.filter((m) => m.role === "user").length === 1
          ? { ...c, title: titleFrom(text) }
          : c,
      );
    },
    [addMessage, endReply, id],
  );

  // The meters and the speaking flag, from the session's levels, every frame.
  useEffect(() => {
    if (phase !== "live") {
      drawBars(youBars.current, 0);
      drawBars(modelBars.current, 0);
      setSpeaking(false);
      return;
    }
    let frame = 0;
    let lastSound = 0;
    const draw = () => {
      const levels = session.current?.levels() ?? { you: 0, model: 0 };
      drawBars(youBars.current, levels.you);
      drawBars(modelBars.current, levels.model);
      const now = performance.now();
      if (levels.model > 0.02) lastSound = now;
      setSpeaking(now - lastSound < 400);
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [phase]);

  const start = async () => {
    if (!service || phase !== "idle") return;
    setPhase("starting");
    setStatus({ text: "Starting" });
    cancelled.current = false;
    const values = { ...settings.values };
    try {
      if (service.fields.some((f) => f.key === "llm_url")) {
        const s = getState();
        const provider = s.providers.find((p) => p.id === s.selection?.providerId);
        if (!provider || !s.selection) throw new Error("Pick a model at the top to talk to.");
        setStatus({ text: "Loading the language model" });
        const llm = await voiceLlm(provider, s.selection.model);
        Object.assign(values, { llm_url: llm.url, llm_model: llm.model, llm_key: llm.key });
      }
    } catch (e) {
      setPhase("idle");
      setStatus({ text: (e as Error).message, error: true });
      waiting.current = [];
      return;
    }
    if (cancelled.current) {
      setPhase("idle");
      setStatus({ text: "" });
      waiting.current = [];
      return;
    }
    const next = new VoiceSession(service, values, mic, {
      status: (text, error) => setStatus({ text, error }),
      ready: () => {
        startedAt.current = Date.now();
        if (!next.micOn) updateVoice({ mic: false });
        setPhase("live");
        for (const text of waiting.current.splice(0)) {
          if (next.say(text)) userLine(text, true);
        }
      },
      text: (text) => {
        const now = Date.now();
        if (reply.current && now - reply.current.at < PARAGRAPH_GAP) {
          const current = reply.current;
          current.at = now;
          updateMessage(id, current.id, (m) => ({ ...m, content: m.content + text }));
          return;
        }
        endReply();
        const message: Message = { id: uid(), role: "assistant", content: text, streaming: true, modelLabel: service.name, voice: { at: seconds() } };
        reply.current = { id: message.id, at: now };
        addMessage(message);
      },
      heard: (text) => userLine(text, false),
      interrupt: () => {
        if (reply.current) updateMessage(id, reply.current.id, (m) => ({ ...m, voice: { at: m.voice?.at ?? 0, cutOff: true } }));
        endReply();
      },
      ended: (error) => {
        endReply();
        session.current = null;
        waiting.current = [];
        setPhase("idle");
        setStatus(error ? { text: error, error: true } : { text: "" });
      },
    });
    session.current = next;
    await next.start();
  };

  const send = () => {
    const text = line.trim();
    if (!text) return;
    setLine("");
    if (phase === "live" && session.current?.say(text)) return userLine(text, true);
    // Not talking yet: start, and say it once the session is ready.
    waiting.current.push(text);
    if (phase === "idle") void start();
  };

  // The bar says what state it's in; anything longer shows above the composer.
  const state =
    phase === "live" ? (speaking ? "Speaking" : "Listening")
    : phase === "starting" || !service ? "Starting"
    : service.status.ready ? "Ready" : "Unavailable";

  return (
    <>
      <VoiceThread messages={conversation.messages} />
      <div className="composer-wrap">
        <div className="composer-stack" ref={sheet.ref}>
          <Notice text={status.text} error={status.error} hidden={sheet.open} />
          <ComposerSheet open={sheet.open}>
            <VoiceSettings
              services={services}
              service={service}
              values={settings.values}
              onService={(serviceId) => updateVoice({ service: serviceId })}
              onChange={settings.set}
            />
          </ComposerSheet>
          <form className="composer voice-composer" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <MessageBox value={line} onChange={setLine} onSubmit={send} />
            <div className="voice-bar">
              <SheetButton open={sheet.open} label="Voice settings" onClick={() => sheet.setOpen((o) => !o)} />
              <button
                type="button"
                className={`think-toggle ${mic ? "is-on" : ""}`}
                aria-pressed={mic}
                title={mic ? "It hears your microphone and what you type." : "It hears only what you type."}
                onClick={() => {
                  const on = !mic;
                  updateVoice({ mic: on });
                  session.current?.setMic(on).catch((e: Error) => {
                    updateVoice({ mic: false });
                    setStatus({ text: e.message, error: true });
                  });
                }}
              >
                {mic ? <MicIcon size={15} /> : <MicOffIcon size={15} />}
                {mic ? "Mic on" : "Mic off"}
              </button>
              <div className="voice-meters">
                <Meter label="You" barsRef={youBars} />
                <Meter label="Model" barsRef={modelBars} />
              </div>
              <span className="voice-status" title={service?.status.detail}>{state}</span>
              {line.trim() && (
                <button type="submit" className="send" aria-label="Send">
                  <ArrowUpIcon size={18} />
                </button>
              )}
              <button
                type="button"
                className={`voice-start ${phase !== "idle" ? "is-live" : ""}`}
                aria-label={phase !== "idle" ? "End" : "Start"}
                disabled={phase === "idle" && !service?.status.ready}
                title={service?.status.detail}
                onClick={() => {
                  if (phase === "idle") return void start();
                  cancelled.current = true;
                  session.current?.stop();
                }}
              >
                {phase !== "idle" ? <StopIcon size={18} /> : <MicIcon size={18} />}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  );
}
