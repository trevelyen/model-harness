// Every outbound model request goes through the dev server's proxy, so any
// endpoint works regardless of its CORS settings.

export function proxied(url: string) {
  return `/api/proxy?url=${encodeURIComponent(url)}`;
}

export async function request(url: string, init: RequestInit = {}) {
  const res = await fetch(proxied(url), init);
  if (!res.ok) throw new Error(await errorText(res));
  return res;
}

export async function errorText(res: Response) {
  const body = await res.text().catch(() => "");
  try {
    const json = JSON.parse(body);
    const message = json?.error?.message ?? json?.error ?? json?.message;
    if (message) return `${res.status}: ${typeof message === "string" ? message : JSON.stringify(message)}`;
  } catch {
    // Not JSON.
  }
  return `${res.status}: ${body.slice(0, 300) || res.statusText}`;
}

export function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function* lines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Yields the data payload of each server-sent event. */
export async function* sse(body: ReadableStream<Uint8Array>) {
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === "") {
      if (data.length) yield data.join("\n");
      data = [];
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length) yield data.join("\n");
}

/** Yields each parsed line of a newline-delimited JSON stream. */
export async function* ndjson<T>(body: ReadableStream<Uint8Array>) {
  for await (const line of lines(body)) {
    if (line.trim()) yield JSON.parse(line) as T;
  }
}
