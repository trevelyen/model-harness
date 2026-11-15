"""The speaking half: a voice model, run as a process of its own.

Each voice model pins a PyTorch, transformers and numpy the app's environment
cannot share, so each lives in a folder here with its own `pyproject.toml`
and `worker.py`, and uv builds and runs that environment. A `Synth` is one of
them: it starts the worker at the first session that picks it, keeps it
between sessions, and talks to it over its pipes. The protocol is in
`pipe.py`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import shutil
from pathlib import Path

import numpy as np

from ..base import Progress, ServiceError

logger = logging.getLogger(__name__)

HERE = Path(__file__).parent
START_TIMEOUT = 60 * 60  # seconds: the first start installs the libraries and downloads the model
STOP_TIMEOUT = 10  # seconds a worker has to end once its stdin is closed
SAMPLE_RATE = 24_000  # what every worker answers in


class Synth:
    def __init__(self, id: str, label: str, folder: str):
        self.id, self.label = id, label
        self._home = HERE / folder
        self.free_tags = False  # whether any short description in brackets is a tag
        self.transcript = False  # whether a voice clip must come with the words said in it
        self.clip_seconds = 0.0  # how much of a clip the model uses, when it says
        self._process: asyncio.subprocess.Process | None = None
        self._reader: asyncio.Task | None = None
        self._waiting: dict[int, asyncio.Future[np.ndarray]] = {}
        self._audio: dict[int, np.ndarray] = {}
        self._next = 0
        self.tags: tuple[str, ...] = ()  # the sounds the model makes from a [tag] in the text

    def unavailable(self) -> str | None:
        if shutil.which("uv") is None:
            return "The voice model runs in an environment that uv builds, and uv was not found."
        return None

    def loaded(self) -> bool:
        return self._process is not None and self._process.returncode is None

    def installed(self) -> bool:
        return (self._home / ".venv").is_dir()

    async def start(self, progress: Progress) -> None:
        if self.loaded():
            return
        await progress("Loading the voice model" if self.installed()
                       else "Installing the voice model's libraries, a few GB")
        environment = {key: value for key, value in os.environ.items() if key != "VIRTUAL_ENV"}
        environment["TQDM_DISABLE"] = "1"  # its progress bars would fill the log
        process = await asyncio.create_subprocess_exec(
            shutil.which("uv"), "run", "--project", str(self._home), "python", str(self._home / "worker.py"),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, env=environment,
        )
        try:
            async with asyncio.timeout(START_TIMEOUT):
                while (ready := json.loads(await process.stdout.readline()))["event"] == "status":
                    await progress(ready["text"])
        except (ValueError, TimeoutError) as error:
            _kill(process)
            raise ServiceError("The voice model could not start; the server's log says why.") from error
        except BaseException:
            _kill(process)
            raise
        self.tags = tuple(ready["tags"])
        self.free_tags, self.transcript = ready["free_tags"], ready["transcript"]
        self.clip_seconds = ready.get("clip_seconds", 0.0)
        self._process = process
        self._reader = asyncio.ensure_future(self._read(process))

    async def stop(self) -> None:
        """End the worker and give its memory back."""
        if not self.loaded():
            return
        process, self._process = self._process, None
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), STOP_TIMEOUT)
        except asyncio.TimeoutError:
            _kill(process)

    async def speak(self, text: str, voice: Path | None, temperature: float, voice_text: str = "") -> np.ndarray:
        """`text` as speech in the voice of the clip at `voice`, or in the model's own.

        `voice_text` is what is said in the clip, for a model that needs it.
        """
        if not self.loaded():
            raise ServiceError("The voice model stopped; the server's log says why.")
        number, self._next = self._next, self._next + 1
        self._waiting[number] = asyncio.get_running_loop().create_future()
        self._send({"op": "speak", "id": number, "text": text, "voice": str(voice) if voice else None,
                    "voice_text": voice_text, "temperature": temperature})
        try:
            return await self._waiting[number]
        finally:
            self._waiting.pop(number, None)

    def cancel(self) -> None:
        """Drop everything asked for and not yet spoken."""
        if self.loaded() and self._next:
            self._send({"op": "cancel", "upto": self._next - 1})
        for waiting in self._waiting.values():
            waiting.cancel()

    def _send(self, request: dict) -> None:
        self._process.stdin.write(json.dumps(request).encode() + b"\n")

    async def _read(self, process: asyncio.subprocess.Process) -> None:
        try:
            while line := await process.stdout.readline():
                event = json.loads(line)
                number = event.get("id")
                if event["event"] == "audio":
                    self._audio[number] = np.frombuffer(await process.stdout.readexactly(event["bytes"]), dtype="<f4")
                    continue
                audio = self._audio.pop(number, np.zeros(0, dtype=np.float32))
                waiting = self._waiting.get(number)
                if waiting is None or waiting.done():
                    continue
                if event["event"] == "error":
                    waiting.set_exception(ServiceError(f"The voice model could not say a line: {event['message']}"))
                else:
                    waiting.set_result(audio)
        except (asyncio.IncompleteReadError, ValueError, ConnectionError):
            logger.exception("the voice model's answers stopped making sense")
            _kill(process)
        finally:
            for waiting in self._waiting.values():
                if not waiting.done():
                    waiting.set_exception(ServiceError("The voice model stopped; the server's log says why."))


def _kill(process: asyncio.subprocess.Process) -> None:
    with contextlib.suppress(ProcessLookupError):
        process.kill()
