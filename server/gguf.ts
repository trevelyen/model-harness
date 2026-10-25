// Reads a GGUF file's header: its final size and its chat template.
// The header lists every tensor's type, shape and offset, so a download that
// has fetched the first few MB already tells us how big it will be.
import { open } from "node:fs/promises";

// ggml type id: [elements per block, bytes per block]
const TYPE_SIZES: Record<number, [number, number]> = {
  0: [1, 4], 1: [1, 2], 2: [32, 18], 3: [32, 20], 6: [32, 22], 7: [32, 24], 8: [32, 34], 9: [32, 36],
  10: [256, 84], 11: [256, 110], 12: [256, 144], 13: [256, 176], 14: [256, 210], 15: [256, 292],
  16: [256, 66], 17: [256, 74], 18: [256, 98], 19: [256, 50], 20: [32, 18], 21: [256, 110],
  22: [256, 82], 23: [256, 136], 24: [1, 1], 25: [1, 2], 26: [1, 4], 27: [1, 8], 28: [1, 8],
  29: [256, 56], 30: [1, 2], 34: [256, 54], 35: [256, 66], 39: [32, 17],
};

class NeedMore extends Error {}

class Reader {
  pos = 0;
  private buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  private take(n: number) {
    if (this.pos + n > this.buf.length) throw new NeedMore();
    const at = this.pos;
    this.pos += n;
    return at;
  }
  u32() { return this.buf.readUInt32LE(this.take(4)); }
  u64() { return Number(this.buf.readBigUInt64LE(this.take(8))); }
  skip(n: number) { this.take(n); }
  string() {
    const length = this.u64();
    const at = this.take(length);
    return this.buf.toString("utf8", at, at + length);
  }
}

// Byte width of fixed-size GGUF value types; 8 is string, 9 is array.
const VALUE_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function skipValue(r: Reader, type: number) {
  if (type === 8) return void r.string();
  if (type === 9) {
    const inner = r.u32();
    const count = r.u64();
    if (inner in VALUE_SIZES) return r.skip(VALUE_SIZES[inner] * count);
    for (let i = 0; i < count; i++) skipValue(r, inner);
    return;
  }
  if (!(type in VALUE_SIZES)) throw new Error(`Unknown GGUF value type ${type}`);
  r.skip(VALUE_SIZES[type]);
}

export interface GgufHeader {
  /** Size of the complete file in bytes. */
  total: number;
  /** The Jinja chat template, which says how the model formats a chat. */
  chatTemplate?: string;
}

function parse(buf: Buffer): GgufHeader {
  const r = new Reader(buf);
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) !== "GGUF") throw new Error("Not a GGUF file");
  r.skip(4);
  const version = r.u32();
  const count = () => (version === 1 ? r.u32() : r.u64());
  const tensorCount = count();
  const kvCount = count();
  let alignment = 32;
  let chatTemplate: string | undefined;
  for (let i = 0; i < kvCount; i++) {
    const key = r.string();
    const type = r.u32();
    if (key === "general.alignment" && type === 4) alignment = r.u32();
    else if (key === "tokenizer.chat_template" && type === 8) chatTemplate = r.string();
    else skipValue(r, type);
  }
  let end = 0;
  for (let i = 0; i < tensorCount; i++) {
    r.string();
    const dims = r.u32();
    let elements = 1;
    for (let d = 0; d < dims; d++) elements *= r.u64();
    const type = r.u32();
    const offset = r.u64();
    const size = TYPE_SIZES[type];
    if (!size) throw new Error(`Unknown tensor type ${type}`);
    end = Math.max(end, offset + (elements / size[0]) * size[1]);
  }
  const dataStart = Math.ceil(r.pos / alignment) * alignment;
  return { total: dataStart + end, chatTemplate };
}

const cache = new Map<string, GgufHeader>();

/**
 * The header of the GGUF at `path`, or undefined when it is not downloaded yet
 * or cannot be read.
 */
export async function readHeader(path: string, currentSize: number): Promise<GgufHeader | undefined> {
  const cached = cache.get(path);
  if (cached !== undefined && cached.total >= currentSize) return cached;
  const file = await open(path, "r");
  try {
    for (let length = 1 << 20; ; length *= 4) {
      const want = Math.min(length, currentSize);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await file.read(buf, 0, want, 0);
      try {
        const header = parse(buf.subarray(0, bytesRead));
        cache.set(path, header);
        return header;
      } catch (error) {
        if (!(error instanceof NeedMore)) return undefined;
        // Header continues past what we read; read more if the file has it.
        if (want >= currentSize || length >= 256 << 20) return undefined;
      }
    }
  } finally {
    await file.close();
  }
}

export interface ReasoningSupport {
  /** Thinking can be switched on and off. */
  toggle: boolean;
  /** Whether the model thinks when not told either way. */
  defaultOn: boolean;
  /** "native": the template takes reasoning_effort. "budget": effort caps thinking tokens instead. */
  effort: "native" | "budget";
}

/** What a model's chat template says about thinking, or undefined if it cannot think. */
export function reasoningSupport(template?: string): ReasoningSupport | undefined {
  if (!template?.includes("enable_thinking")) return undefined;
  return {
    toggle: true,
    // Gemma 4 writes `enable_thinking | default(false)`; Qwen thinks unless told not to.
    defaultOn: !/enable_thinking\s*\|\s*default\(\s*false\s*\)/.test(template),
    effort: template.includes("reasoning_effort") ? "native" : "budget",
  };
}
