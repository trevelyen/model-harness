"""The voice server model-harness's daemon starts: the service and voice lists, and one socket per session.

server/voice.ts in model-harness forwards the page's /api/voice/<path> to
/api/<path> here, and its /api/voice/session socket to /ws/session.

    GET    /api/services            every service: what it is, its fields, its status
    GET    /api/voices              the voice library
    POST   /api/voices?name=...     add a voice; the body is an audio file
    GET    /api/voices/{id}/audio   a voice's clip
    DELETE /api/voices/{id}
    GET    /ws/session              one session, see `session()`

It listens on HOST and PORT (127.0.0.1:8787 without them) and fails rather
than move to another port. Variables in a `.env` file in the working
directory fill in any the environment does not set, so an API key can stay
out of the run command and out of git.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path

import numpy as np
from aiohttp import WSMsgType, web
from yarl import URL

from . import fields, typed
from .services import registry
from .services.base import Audio, Heard, Interrupt, Report, ServiceError, Session, Stats, TakesText, Text
from .voices import MAX_BYTES, VoiceStore

logger = logging.getLogger("speech_testing")

START_TIMEOUT = 30  # seconds a new socket has to say what it wants
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
SHUTDOWN_TIMEOUT = 2  # seconds a stop waits for open sessions; one loading a model does not end sooner

SERVICES = web.AppKey("services", dict)
VOICES = web.AppKey("voices", VoiceStore)
SPEAKER = web.AppKey("speaker", typed.Speaker)
HOSTS = web.AppKey("hosts", set)


@web.middleware
async def guard(request: web.Request, handler):
    """Only this app's own page may use the server.

    A request must name a host the server is known by, which stops a page
    elsewhere from reaching it under a name it made resolve here, and a
    request that changes something or opens a socket must come from a page
    of that same host.
    """
    host = URL(f"//{request.host}").host
    if host not in request.app[HOSTS]:
        raise web.HTTPForbidden(text="unknown host")
    origin = request.headers.get("Origin")
    changes = request.method not in ("GET", "HEAD") or request.headers.get("Upgrade", "").lower() == "websocket"
    if origin and changes and URL(origin).host != host:
        raise web.HTTPForbidden(text="cross-origin request")
    try:
        return await handler(request)
    except (ValueError, ServiceError) as error:
        return web.json_response({"message": str(error)}, status=400)


async def list_services(request: web.Request) -> web.Response:
    return web.json_response([
        {
            "id": service.id, "name": service.name, "kind": service.kind.value, "summary": service.summary,
            "sampleRate": service.sample_rate, "ahead": service.ahead,
            "fields": [fields.describe(field) for field in service.fields()],
            "status": {"ready": (status := service.status()).ready, "detail": status.detail},
        }
        for service in request.app[SERVICES].values()
    ])


async def list_voices(request: web.Request) -> web.Response:
    return web.json_response([voice.describe() for voice in request.app[VOICES].list()])


async def add_voice(request: web.Request) -> web.Response:
    data = await request.read()
    voice = await asyncio.to_thread(request.app[VOICES].add, request.query.get("name", ""), data)
    return web.json_response(voice.describe())


async def voice_audio(request: web.Request) -> web.FileResponse:
    return web.FileResponse(request.app[VOICES].path(request.match_info["id"]))


async def remove_voice(request: web.Request) -> web.Response:
    request.app[VOICES].remove(request.match_info["id"])
    return web.Response(status=204)


async def session(request: web.Request) -> web.WebSocketResponse:
    """One session over a socket.

    The page sends `{type: "start", service, settings}` once, then the person's
    audio as binary messages: mono float32 at the service's sample rate. The
    server answers `status` messages while the service gets ready, then
    `ready`, then the service's audio as binary messages in the same format
    beside `text`, `heard`, `interrupt`, `stats` and `status` messages, and
    `ended` or `error` at the end.

    After `ready` the page may also send `{type: "say", text}`. A session
    that takes text is given the line as it is. For any other the server
    speaks the line and mixes it into the person's audio as that arrives, so
    the page must keep sending audio (silence will do). A line that cannot be
    spoken is answered with `notice`; the session goes on.
    """
    ws = web.WebSocketResponse(max_msg_size=1 << 20)
    await ws.prepare(request)

    async def progress(text: str) -> None:
        await ws.send_json({"type": "status", "text": text})

    opened: Session | None = None
    pump = speaking = None
    lines = typed.Lines()
    said: asyncio.Queue[str] = asyncio.Queue()
    try:
        start = await ws.receive_json(timeout=START_TIMEOUT)
        service = request.app[SERVICES].get(start.get("service")) if isinstance(start, dict) else None
        if service is None or start.get("type") != "start":
            raise ServiceError("The session did not name a service.")
        settings = fields.read(service.fields(), start.get("settings") or {})
        opened = await service.open(settings, progress)
        await ws.send_json({"type": "ready"})
        pump = asyncio.ensure_future(_send_events(ws, opened))
        speaking = asyncio.ensure_future(_speak(ws, request.app[SPEAKER], said, lines, service.sample_rate))
        async for message in ws:
            if message.type == WSMsgType.BINARY and len(message.data) % 4 == 0:
                opened.feed(lines.mix(np.frombuffer(message.data, dtype="<f4")))
            elif message.type == WSMsgType.TEXT:
                line = _line(message.data)
                if line and isinstance(opened, TakesText):
                    opened.say(line)
                elif line:
                    said.put_nowait(line)
    except (ValueError, TypeError, ServiceError, asyncio.TimeoutError) as error:
        if not ws.closed:
            await ws.send_json({"type": "error", "message": str(error) or "The session could not start."})
    finally:
        for task in (pump, speaking):
            if task:
                task.cancel()
        if opened:
            await opened.close()
        await ws.close()
    return ws


def _line(data: str) -> str:
    """The text of a `say` message, or "" for anything else."""
    try:
        message = json.loads(data)
    except ValueError:
        return ""
    if not isinstance(message, dict) or message.get("type") != "say" or not isinstance(message.get("text"), str):
        return ""
    return message["text"].strip()[: typed.MAX_CHARACTERS]


async def _speak(ws: web.WebSocketResponse, speaker: typed.Speaker, said: asyncio.Queue[str],
                 lines: typed.Lines, sample_rate: int) -> None:
    """Speak the lines the page types, one at a time and in order."""

    async def progress(text: str) -> None:
        await ws.send_json({"type": "status", "text": text})

    while True:
        text = await said.get()
        try:
            lines.add(await speaker.speak(text, sample_rate, progress))
        except Exception as error:
            logger.exception("could not speak a typed line")
            try:
                await ws.send_json({"type": "notice", "message": f"That line could not be spoken: {error}"})
            except ConnectionError:
                return


async def _send_events(ws: web.WebSocketResponse, opened: Session) -> None:
    try:
        async for event in opened.events():
            match event:
                case Audio(pcm):
                    await ws.send_bytes(pcm.astype("<f4", copy=False).tobytes())
                case Text(text):
                    await ws.send_json({"type": "text", "text": text})
                case Heard(text):
                    await ws.send_json({"type": "heard", "text": text})
                case Interrupt():
                    await ws.send_json({"type": "interrupt"})
                case Report(text):
                    await ws.send_json({"type": "status", "text": text})
                case Stats(step_ms, frame_ms):
                    await ws.send_json({"type": "stats", "stepMs": step_ms, "frameMs": frame_ms})
        await ws.send_json({"type": "ended"})
    except ServiceError as error:
        await ws.send_json({"type": "error", "message": str(error)})
    except ConnectionError:
        pass
    finally:
        await ws.close()


def build(data: Path, hosts: set[str]) -> web.Application:
    app = web.Application(middlewares=[guard], client_max_size=MAX_BYTES)
    voices = VoiceStore(data / "voices")
    app[VOICES] = voices
    app[SPEAKER] = typed.Speaker(data / "tts")
    app[SERVICES] = registry(voices)
    app[HOSTS] = hosts
    app.router.add_get("/api/services", list_services)
    app.router.add_get("/api/voices", list_voices)
    app.router.add_post("/api/voices", add_voice)
    app.router.add_get("/api/voices/{id}/audio", voice_audio)
    app.router.add_delete("/api/voices/{id}", remove_voice)
    app.router.add_get("/ws/session", session)
    return app


def _load_env(path: Path) -> None:
    """`NAME=value` lines from `path` into the environment, under any already set there."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        name, equals, value = line.strip().partition("=")
        if equals and name and not name.startswith("#"):
            os.environ.setdefault(name.strip(), value.strip().strip("'\""))


def main() -> None:
    _load_env(Path(".env"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx2").setLevel(logging.WARNING)  # the model download logs every request
    logging.getLogger("httpx").setLevel(logging.WARNING)
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8787"))
    data = Path(os.environ.get("SPEECH_TESTING_DATA", "data")).resolve()
    extra = {name.strip() for name in os.environ.get("SPEECH_TESTING_HOSTS", "").split(",") if name.strip()}
    app = build(data, LOCAL_HOSTS | {host} | extra)
    try:
        web.run_app(app, host=host, port=port, reuse_port=False, shutdown_timeout=SHUTDOWN_TIMEOUT, print=lambda _: logger.info("http://%s:%d", host, port))
    except OSError as error:
        sys.exit(f"speech-testing: cannot listen on {host}:{port}: {error}")


if __name__ == "__main__":
    main()
