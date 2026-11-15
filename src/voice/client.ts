// The browser half of a voice chat, ported from speech-testing's page. The
// voice server (speech/, started by the daemon) runs the services; this file
// lists them and their voices, and runs one session: the microphone in, the
// service's audio out, both as mono float32 at the service's sample rate over
// the session socket. The AudioContext runs at that rate, so the browser does
// all resampling.
import { errorText } from "../lib/http";

export type VoiceField =
  | { key: string; label: string; help: string; default: string; type: "text"; multiline: boolean }
  | { key: string; label: string; help: string; default: number; type: "number"; min: number; max: number; step: number }
  | { key: string; label: string; help: string; default: boolean; type: "toggle" }
  | { key: string; label: string; help: string; default: string; type: "choice"; options: { value: string; label: string }[] }
  | { key: string; label: string; help: string; default: string; type: "voice" };

export interface VoiceService {
  id: string;
  name: string;
  kind: string;
  summary: string;
  sampleRate: number;
  /** Its audio arrives faster than it plays, so the player keeps all of it. */
  ahead: boolean;
  fields: VoiceField[];
  status: { ready: boolean; detail: string };
}

export interface VoiceClip {
  id: string;
  seconds: number;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/voice/${path}`, init);
  if (!res.ok) throw new Error(await errorText(res));
  return (res.status === 204 ? null : await res.json()) as T;
}

export const listServices = () => api<VoiceService[]>("services");
export const listVoices = () => api<VoiceClip[]>("voices");
export const addVoice = (name: string, audio: Blob) => api<VoiceClip>(`voices?name=${encodeURIComponent(name)}`, { method: "POST", body: audio });
export const removeVoice = (id: string) => api<null>(`voices/${id}`, { method: "DELETE" });
export const voiceAudioUrl = (id: string) => `/api/voice/voices/${id}/audio`;

/** Whether the voice server is running, without starting it. */
export async function voiceServerRunning() {
  const res = await fetch("/api/voice/status");
  return res.ok && (await res.json()).state === "running";
}

/** Stops the voice server, which frees its models' GPU memory. It starts again with the next voice chat. */
export async function stopVoiceServer() {
  const res = await fetch("/api/voice/stop", { method: "POST" });
  if (!res.ok) throw new Error(await errorText(res));
}

/** Cascade's language model: where the app's picked model answers, its name there, and its key. */
export async function voiceLlm(provider: { adapter: string; settings: Record<string, string> }, model: string) {
  const res = await fetch("/api/voice/llm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as { url: string; model: string; key: string };
}

const MICROPHONE = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
const CLIP_RATE = 24000;

/** A capture node on `context`, for a source to feed. A node that leads nowhere isn't always run, so it is tied to the output through silence. */
async function capture(context: AudioContext, onBlock: (block: Float32Array) => void) {
  await context.audioWorklet.addModule("/voice/capture.js");
  const node = new AudioWorkletNode(context, "capture", { numberOfInputs: 1, numberOfOutputs: 1 });
  node.port.onmessage = (event) => onBlock(event.data);
  const mute = new GainNode(context, { gain: 0 });
  node.connect(mute).connect(context.destination);
  return node;
}

const micError = (error: unknown) =>
  new Error((error as Error).name === "NotAllowedError" ? "The microphone was not allowed." : (error as Error).message);

/** Silence in place of the microphone: a duplex service needs audio all the time. */
function silence(context: AudioContext) {
  const node = new ConstantSourceNode(context, { offset: 0 });
  node.start();
  return node;
}

function close(context: AudioContext, stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
  if (context.state !== "closed") void context.close();
}

/** How loud an analyser's input is right now, from 0 to 1. */
function level(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>) {
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

export interface SessionEvents {
  /** A line on how the session is going, or "" to clear it. */
  status(text: string, isError?: boolean): void;
  ready(): void;
  /** What the service is saying, as it says it. */
  text(text: string): void;
  /** What the service took the person to have said. */
  heard(text: string): void;
  /** The person cut in; what was queued to play is dropped. */
  interrupt(): void;
  /** The session is over. `error` says why, when it went wrong. */
  ended(error: string): void;
}

/** One conversation with a service, from start() until stop(). */
export class VoiceSession {
  private context: AudioContext;
  private stream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private playback: AudioWorkletNode | null = null;
  private micLevel: AnalyserNode | null = null;
  private captureNode: AudioWorkletNode | null = null;
  // What feeds the capture node: the microphone, or silence until there is one.
  private source: AudioNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private silent: ConstantSourceNode | null = null;
  private modelLevel: AnalyserNode | null = null;
  private samples = new Float32Array(1024);
  private closed = false;
  isReady = false;

  /** Whether the service hears the microphone, which a refused request turns off. */
  get micOn() {
    return this.mic;
  }

  constructor(
    private service: VoiceService,
    private settings: Record<string, unknown>,
    private mic: boolean,
    private on: SessionEvents,
  ) {
    this.context = new AudioContext({ sampleRate: service.sampleRate, latencyHint: "interactive" });
  }

  async start() {
    try {
      if (this.mic) {
        this.on.status("Asking for the microphone");
        const stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
        if (this.closed) return close(this.context, stream); // stopped while the browser was asking
        this.stream = stream;
      }
      await this.context.audioWorklet.addModule("/voice/playback.js");
      if (this.closed) return;
      this.playback = new AudioWorkletNode(this.context, "playback", {
        numberOfInputs: 0,
        outputChannelCount: [1],
        processorOptions: { ahead: this.service.ahead },
      });
      this.modelLevel = new AnalyserNode(this.context, { fftSize: 1024 });
      this.playback.connect(this.modelLevel).connect(this.context.destination);

      const ws = (this.ws = new WebSocket(new URL("/api/voice/session", location.href).href.replace(/^http/, "ws")));
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws.send(JSON.stringify({ type: "start", service: this.service.id, settings: this.settings }));
      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return this.playback?.port.postMessage(new Float32Array(event.data), [event.data]);
        void this.onMessage(JSON.parse(event.data));
      };
      ws.onclose = () => this.stop(this.isReady ? "" : "The voice server closed the connection.");
      this.on.status("Connecting");
    } catch (error) {
      this.stop(micError(error).message);
    }
  }

  private async onMessage(message: { type: string; text?: string; message?: string; stepMs?: number; frameMs?: number }) {
    switch (message.type) {
      case "status":
        return this.on.status(message.text ?? "");
      case "text":
        return this.on.text(message.text ?? "");
      case "heard":
        return this.on.heard(message.text ?? "");
      case "notice":
        return this.on.status(message.message ?? "", true);
      case "error":
        return this.stop(message.message ?? "The session failed.");
      case "ended":
        return this.stop("The conversation reached its length limit.");
      case "interrupt":
        this.playback?.port.postMessage("clear");
        return this.on.interrupt();
      case "stats": {
        // Haru's frames: only worth a word when it falls behind.
        if ((message.stepMs ?? 0) > (message.frameMs ?? Infinity)) this.on.status("Falling behind: each frame takes longer to make than to play", true);
        return;
      }
      case "ready": {
        this.isReady = true;
        this.captureNode = await capture(this.context, (block) => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(block);
        });
        this.micLevel = new AnalyserNode(this.context, { fftSize: 1024 });
        let refused = "";
        try {
          await this.setMic(this.mic);
        } catch (error) {
          // Switched on while starting, then refused: carry on with silence.
          refused = (error as Error).message;
        }
        this.on.status(refused, !!refused);
        return this.on.ready();
      }
    }
  }

  /**
   * Turns the microphone on or off, mid-session too. Off, the service hears
   * silence. Turning it on in a session that started without it asks the
   * browser for the microphone, and throws if that's refused.
   */
  async setMic(on: boolean) {
    this.mic = on;
    if (!this.isReady || this.closed || !this.captureNode || !this.micLevel) return; // wired once the session is ready
    if (on && !this.stream) {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
      } catch (error) {
        this.mic = false;
        throw micError(error);
      }
      if (this.closed) return close(this.context, stream);
      this.stream = stream;
    }
    // A muted microphone track plays silence, so once there is one it stays connected.
    this.stream?.getAudioTracks().forEach((track) => (track.enabled = on));
    const next = this.stream
      ? (this.micSource ??= this.context.createMediaStreamSource(this.stream))
      : (this.silent ??= silence(this.context));
    if (next === this.source) return;
    this.source?.disconnect();
    next.connect(this.captureNode);
    next.connect(this.micLevel);
    this.source = next;
  }

  /** A typed line. Cascade takes it as text; other services hear it spoken. */
  say(text: string) {
    if (!this.isReady || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: "say", text }));
    return true;
  }

  /** How loud each side is right now, from 0 to 1, for the meters. */
  levels() {
    return {
      you: this.micLevel ? level(this.micLevel, this.samples) : 0,
      model: this.modelLevel ? level(this.modelLevel, this.samples) : 0,
    };
  }

  stop(error = "") {
    if (this.closed) return;
    this.closed = true;
    this.ws?.close();
    close(this.context, this.stream);
    this.on.ended(error);
  }
}

/** Records the microphone until stop(), which resolves to a WAV file, for adding a voice. */
export async function recordClip(onSeconds: (seconds: number) => void) {
  const context = new AudioContext({ sampleRate: CLIP_RATE });
  let stream: MediaStream | null = null;
  const blocks: Float32Array[] = [];
  let samples = 0;
  try {
    stream = await navigator.mediaDevices.getUserMedia(MICROPHONE);
    const node = await capture(context, (block) => {
      blocks.push(block);
      samples += block.length;
      onSeconds(samples / CLIP_RATE);
    });
    context.createMediaStreamSource(stream).connect(node);
  } catch (error) {
    close(context, stream);
    throw error;
  }
  return {
    async stop() {
      close(context, stream);
      return wav(blocks, samples, CLIP_RATE);
    },
  };
}

function wav(blocks: Float32Array[], samples: number, rate: number) {
  const view = new DataView(new ArrayBuffer(44 + 2 * samples));
  const tag = (at: number, text: string) => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + 2 * samples, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, 2 * rate, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, 2 * samples, true);
  let at = 44;
  for (const block of blocks) {
    for (const sample of block) {
      view.setInt16(at, Math.max(-1, Math.min(1, sample)) * 32767, true);
      at += 2;
    }
  }
  return new Blob([view], { type: "audio/wav" });
}
