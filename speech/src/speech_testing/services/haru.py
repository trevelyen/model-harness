"""Haru 4B: higurashi's full-duplex spoken dialogue model, run in this process.

higurashi publishes two implementations of the same model, and this adapter
picks one by platform: `haru_mlx` (haru-speech-mlx) on a Mac with Apple
silicon, and `haru` (haru-speech, PyTorch) on Linux with an NVIDIA GPU. Each
is an engine below; the rest of the adapter does not know which it has.

The model works in frames of 133 ms: each whole frame of the person's audio
yields the model's next frame of audio and text. All model work runs on the
backend's one model thread.
"""

from __future__ import annotations

import asyncio
import functools
import importlib.util
import json
import logging
import os
import platform
import statistics
import time
from importlib import resources
from typing import Any, AsyncIterator, Callable, Protocol

import numpy as np

from ..fields import ChoiceField, Field, NumberField, TextField, ToggleField, VoiceField
from ..voices import VoiceError, VoiceStore
from .base import Audio, Event, Kind, Progress, ServiceError, Stats, Status, Text

logger = logging.getLogger(__name__)

REPO = "higurashi-ai/Haru-4B"
MIN_REFERENCE_SECONDS = 3.0
STATS_EVERY = 8  # frames, about a second
SMALL_MEMORY = 24 << 30  # below this the published weights leave too little room
MIN_GPU_MEMORY = 12 << 30  # what higurashi asks of a CUDA GPU


def _downloaded() -> bool:
    from huggingface_hub import try_to_load_from_cache

    return isinstance(try_to_load_from_cache(REPO, "model.safetensors"), str)


class Conversation(Protocol):
    """One live conversation on an engine, as `HaruSession` drives it."""

    frame_samples: int
    frame_seconds: float

    async def start(self): ...

    def feed(self, pcm: np.ndarray) -> None:
        """Take the person's audio as it arrives, any length."""
        ...

    async def step(self, arrived: float):
        """The model's next frame, from the oldest whole frame fed; `arrived` is when that frame completed."""
        ...

    def close(self) -> None: ...


class Engine(Protocol):
    summary: str
    precisions: tuple[tuple[str, str], ...]  # empty when there is no choice

    def unavailable(self) -> str | None:
        """Why the model cannot run here, or None."""
        ...

    def loaded(self) -> str | None:
        """The loaded model in a few words, or None before the first load."""
        ...

    def default_card(self) -> str: ...

    def default_precision(self) -> str: ...

    def reference(self, path) -> np.ndarray:
        """A voice clip as the model takes it: mono float32 at 24 kHz, silence trimmed."""
        ...

    async def open(self, settings: dict[str, Any], reference: np.ndarray | None, progress: Progress) -> Conversation:
        """Load the model if it is not loaded at this precision, then start a conversation on it."""
        ...


class Mlx:
    """`haru_mlx` on Apple silicon. Its session takes audio as it arrives and steps on a whole frame."""

    summary = "Full-duplex spoken dialogue from higurashi, running on this Mac with MLX."
    precisions = (("bf16", "bfloat16, as published"), ("int8", "8-bit backbone, smaller and faster"))

    def __init__(self):
        self._backend = None  # the loaded model, kept between sessions

    def unavailable(self) -> str | None:
        if importlib.util.find_spec("haru_mlx") is None:
            return "The haru-speech-mlx package is not installed."
        return None

    def loaded(self) -> str | None:
        if self._backend is None:
            return None
        return "8-bit" if self._backend.quantize else "bfloat16"

    def default_card(self) -> str:
        """The package's example character, in English."""
        try:
            from haru_mlx.native import bundled_assets
            from haru_mlx.prompt import render_card

            assets = bundled_assets()
            return render_card(assets["presets"]["en"][0]["card"], assets["templates"]["en"])
        except Exception:
            return ""

    def default_precision(self) -> str:
        try:
            memory = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
        except (ValueError, OSError):
            return "bf16"
        return "int8" if memory < SMALL_MEMORY else "bf16"

    def reference(self, path) -> np.ndarray:
        from haru_mlx.audio import load_audio, prepare_reference

        return prepare_reference(load_audio(path))

    async def open(self, settings: dict[str, Any], reference: np.ndarray | None, progress: Progress) -> Conversation:
        from haru_mlx.backends import SessionSettings

        backend = await self._load(8 if settings["precision"] == "int8" else None, progress)
        await progress("Preparing the conversation")
        return MlxConversation(backend, backend.session(SessionSettings(**_session_settings(settings), reference=reference)))

    async def _load(self, quantize: int | None, progress: Progress):
        """The model at this precision, loaded once and kept; another precision replaces it."""
        from haru_mlx.backends import LocalBackend

        if self._backend is not None:
            if self._backend.quantize == quantize:
                return self._backend
            # A backend owns its MLX thread for good, so the old one is emptied
            # rather than stopped; its thread then waits on an empty queue.
            old, self._backend = self._backend, None
            await old.worker.run(_release_mlx, old)
        await progress("Loading the model" if _downloaded() else "Downloading the model, about 10 GB")
        backend = LocalBackend(REPO, quantize=quantize)
        await backend.load()
        self._backend = backend
        return backend


def _release_mlx(backend) -> None:
    """Drop a backend's model, on its own MLX thread."""
    import gc

    import mlx.core as mx

    backend.model = None
    gc.collect()
    mx.clear_cache()


class MlxConversation:
    def __init__(self, backend, session):
        self._worker = backend.worker
        self._session = session
        self.frame_samples = backend.model.config.frame_samples
        self.frame_seconds = backend.frame_seconds

    async def start(self):
        return await self._worker.run(self._session.start)

    def feed(self, pcm: np.ndarray) -> None:
        self._worker.submit(self._session.feed, pcm)

    async def step(self, arrived: float):
        frame = await self._worker.run(self._session.step)
        # The next frame of the person's audio completes one frame after this one did.
        self._worker.expect(arrived + self.frame_seconds)
        return frame

    def close(self) -> None:
        self._worker.expect(None)
        self._session = None  # drops the conversation's cache


@functools.cache
def _cuda() -> tuple[str, int] | None:
    """The first CUDA GPU's name and memory, or None. Importing torch takes a moment, so once."""
    import torch

    if not torch.cuda.is_available():
        return None
    properties = torch.cuda.get_device_properties(0)
    return properties.name, properties.total_memory


class Torch:
    """`haru` (PyTorch) on an NVIDIA GPU. Its session steps on one whole frame of audio, passed in."""

    summary = "Full-duplex spoken dialogue from higurashi, running on this machine's GPU with PyTorch."
    precisions = ()  # the package runs the published bfloat16 only

    def __init__(self):
        self._backend = None  # the loaded model, kept between sessions

    def unavailable(self) -> str | None:
        if importlib.util.find_spec("haru") is None:
            return "The haru-speech package is not installed."
        gpu = _cuda()
        if gpu is None:
            return "Haru runs here through PyTorch, which needs an NVIDIA GPU with CUDA, and none was found."
        name, memory = gpu
        if memory < MIN_GPU_MEMORY:
            return f"Haru needs a GPU with about 12 GB of memory; the {name} has {memory / (1 << 30):.0f} GB."
        return None

    def loaded(self) -> str | None:
        if self._backend is None:
            return None
        return f"bfloat16 on the {_cuda()[0]}"

    def default_card(self) -> str:
        """The package's example character, in English."""
        try:
            from haru.prompt import card_templates, render_card

            cards = json.loads((resources.files("haru") / "assets" / "cards" / "en.json").read_text(encoding="utf-8"))
            return render_card(next(iter(cards.values())), card_templates()["templates"]["en"])
        except Exception:
            return ""

    def default_precision(self) -> str:
        return "bf16"

    def reference(self, path) -> np.ndarray:
        from haru.audio import load_audio, prepare_reference

        return prepare_reference(load_audio(path))

    async def open(self, settings: dict[str, Any], reference: np.ndarray | None, progress: Progress) -> Conversation:
        from haru.backends import LocalBackend, SessionSettings

        if self._backend is None:
            await progress("Loading the model" if _downloaded() else "Downloading the model, about 10 GB")
            # PyTorch's codec, the package's default. The Triton one is a few ms a frame faster,
            # but its CUDA graph capture at a conversation's first frame sometimes fails.
            backend = LocalBackend(REPO, codec_backend="torch")
            try:
                await backend.load()
            except Exception:
                # A load that failed part way, out of memory say, would keep what it loaded.
                await backend.run(_release_torch, backend)
                raise
            self._backend = backend
        await progress("Preparing the conversation")
        conversation = await self._backend.open(SessionSettings(**_session_settings(settings), reference=reference))
        return TorchConversation(self._backend.model.config, conversation)


def _release_torch(backend) -> None:
    """Drop a backend's model and give its memory back to the GPU, on its model thread."""
    import gc

    import torch

    backend.model = None
    gc.collect()
    torch.cuda.empty_cache()


class TorchConversation:
    def __init__(self, config, conversation):
        self._conversation = conversation  # the package's, which runs each call on the model thread
        self.frame_samples = config.frame_samples
        self.frame_seconds = 1.0 / config.frame_rate
        self._pending = np.zeros(0, dtype=np.float32)  # the person's audio not yet stepped

    async def start(self):
        return await self._conversation.start()

    def feed(self, pcm: np.ndarray) -> None:
        self._pending = np.concatenate((self._pending, np.asarray(pcm, dtype=np.float32)))

    async def step(self, arrived: float):
        frame, self._pending = self._pending[: self.frame_samples], self._pending[self.frame_samples :]
        return await self._conversation.step(frame)

    def close(self) -> None:
        self._conversation = None  # drops the conversation's cache


def _session_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """The settings both packages' `SessionSettings` take, apart from the voice."""
    keys = ("system_prompt", "guidance_scale", "temperature", "speak_first")
    return {key: settings[key] for key in keys}


def _engine() -> Engine | None:
    system, machine = platform.system(), platform.machine()
    if system == "Darwin" and machine == "arm64":
        return Mlx()
    if system == "Linux":
        return Torch()
    return None


class Haru:
    id = "haru"
    name = "Haru 4B"
    kind = Kind.DUPLEX
    sample_rate = 24_000
    ahead = False  # one frame of audio per frame of the person's

    def __init__(self, voices: VoiceStore):
        self._voices = voices
        self._engine = _engine()
        self.summary = self._engine.summary if self._engine else "Full-duplex spoken dialogue from higurashi."
        self._busy = False  # one conversation at a time: they would share one GPU

    def fields(self) -> list[Field]:
        engine = self._engine
        fields: list[Field] = [
            TextField(
                "system_prompt", "Character", default=engine.default_card() if engine else "", multiline=True,
                help="Who the model is and the situation it is in. Haru is a base model: it plays a "
                "character, it does not follow instructions.",
            ),
            VoiceField(
                "voice", "Voice",
                help="One speaker, 3 seconds to 3 minutes of clean speech. Without one the model "
                "speaks in a voice of its own choosing.",
            ),
        ]
        if engine and engine.precisions:
            fields.append(ChoiceField(
                "precision", "Precision", default=engine.default_precision(), options=engine.precisions,
                help="Changing this reloads the model at the next start.",
            ))
        fields += [
            NumberField("guidance_scale", "Voice guidance", 1.5, 1.0, 2.0, 0.1,
                        help="How closely the audio follows the voice."),
            NumberField("temperature", "Temperature", 0.7, 0.1, 1.5, 0.05),
            ToggleField("speak_first", "Model speaks first"),
        ]
        return fields

    def status(self) -> Status:
        if self._engine is None:
            return Status(False, "Haru runs on a Mac with Apple silicon, or on Linux with an NVIDIA GPU.")
        if reason := self._engine.unavailable():
            return Status(False, reason)
        if loaded := self._engine.loaded():
            return Status(True, f"The model is loaded ({loaded}).")
        if _downloaded():
            return Status(True, "The model is downloaded and loads at the first start.")
        return Status(True, "The first start downloads the model, about 10 GB.")

    async def open(self, settings: dict[str, Any], progress: Progress) -> "HaruSession":
        if self._engine is None or self._engine.unavailable():
            raise ServiceError(self.status().detail)
        if self._busy:
            raise ServiceError("Haru is already in a conversation.")
        self._busy = True
        try:
            reference = None
            if settings["voice"]:
                reference = await asyncio.to_thread(self._reference, settings["voice"])
            conversation = await self._engine.open(settings, reference, progress)
            first = await conversation.start()
            return HaruSession(conversation, first, self._free)
        except (ServiceError, VoiceError):
            self._free()
            raise
        except Exception as error:
            self._free()
            logger.exception("haru could not start")
            raise ServiceError(f"Haru could not start: {error}") from error

    def _free(self) -> None:
        self._busy = False

    def _reference(self, voice_id: str) -> np.ndarray:
        clip = self._engine.reference(self._voices.path(voice_id))
        seconds = len(clip) / self.sample_rate
        if seconds < MIN_REFERENCE_SECONDS:
            raise ServiceError(
                f"The voice is too short ({seconds:.1f} s once silence is trimmed); "
                f"Haru needs at least {MIN_REFERENCE_SECONDS:g} s of speech."
            )
        return clip


class HaruSession:
    """One conversation: audio fed as it arrives, one model frame per whole frame of it."""

    def __init__(self, conversation: Conversation, first, release: Callable[[], None]):
        self._conversation: Conversation | None = conversation
        self._release = release
        self._frame_samples = conversation.frame_samples
        self._frame_seconds = conversation.frame_seconds
        self._events: asyncio.Queue[Event | Exception | None] = asyncio.Queue()
        self._complete: asyncio.Queue[float] = asyncio.Queue()  # arrival time of each whole frame
        self._received = self._queued = 0
        self._emit(first)
        self._task = asyncio.ensure_future(self._generate())

    def feed(self, pcm: np.ndarray) -> None:
        if self._conversation is None or not len(pcm):
            return
        self._conversation.feed(pcm)
        self._received += len(pcm)
        while self._received >= (self._queued + 1) * self._frame_samples:
            self._queued += 1
            self._complete.put_nowait(time.perf_counter())

    async def events(self) -> AsyncIterator[Event]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            if isinstance(event, Exception):
                raise ServiceError(f"Haru stopped: {event}") from event
            yield event

    async def close(self) -> None:
        if self._conversation is None:
            return
        self._task.cancel()
        self._conversation.close()
        self._conversation = None
        self._release()

    def _emit(self, frame) -> None:
        self._events.put_nowait(Audio(frame.audio))
        if frame.text:
            self._events.put_nowait(Text(frame.text))

    async def _generate(self) -> None:
        steps: list[float] = []
        try:
            while True:
                arrived = await self._complete.get()
                frame = await self._conversation.step(arrived)
                self._emit(frame)
                steps.append(frame.seconds)
                if len(steps) == STATS_EVERY:
                    self._events.put_nowait(Stats(1000 * statistics.median(steps), 1000 * self._frame_seconds))
                    steps.clear()
                if frame.done:
                    self._events.put_nowait(None)
                    return
        except Exception as error:
            logger.exception("haru stopped")
            self._events.put_nowait(error)
