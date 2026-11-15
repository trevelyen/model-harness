"""What the person types, spoken, so a service can be tested without a microphone.

`Speaker` turns a line of text into speech with Kokoro (through kokoro-onnx,
on the CPU, so it never competes with a service for the GPU). A session keeps
its spoken lines in `Lines`, which mixes them into the person's audio as it
arrives: the line reaches the service at the pace of real speech, in place of
the silence or beside the microphone.
"""

from __future__ import annotations

import asyncio
import logging
import urllib.request
from pathlib import Path

import numpy as np

from .services.base import Progress

logger = logging.getLogger(__name__)

RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = ("kokoro-v1.0.onnx", "voices-v1.0.bin")  # about 310 MB and 26 MB
VOICE = "af_heart"
MAX_CHARACTERS = 1000


class Speaker:
    """Kokoro, loaded at the first line any session types and kept. One line is spoken at a time."""

    def __init__(self, root: Path):
        self.root = root  # where the model files are kept
        self._kokoro = None
        self._lock = asyncio.Lock()

    async def speak(self, text: str, sample_rate: int, progress: Progress) -> np.ndarray:
        """`text` as mono float32 speech at `sample_rate`."""
        async with self._lock:
            if self._kokoro is None:
                if not all((self.root / name).is_file() for name in FILES):
                    await progress("Downloading text to speech, about 340 MB")
                    await asyncio.to_thread(self._download)
                await progress("Loading text to speech")
                self._kokoro = await asyncio.to_thread(self._load)
            audio, rate = await asyncio.to_thread(self._kokoro.create, text, VOICE)
        return _resample(np.asarray(audio, dtype=np.float32), rate, sample_rate)

    def _download(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        for name in FILES:
            path = self.root / name
            if path.is_file():
                continue
            partial = path.with_suffix(path.suffix + ".part")
            logger.info("downloading %s", name)
            urllib.request.urlretrieve(f"{RELEASE}/{name}", partial)
            partial.rename(path)

    def _load(self):
        from kokoro_onnx import Kokoro

        return Kokoro(str(self.root / FILES[0]), str(self.root / FILES[1]))


def _resample(audio: np.ndarray, rate: int, target: int) -> np.ndarray:
    if rate == target:
        return audio
    times = np.arange(round(len(audio) * target / rate)) / target
    return np.interp(times, np.arange(len(audio)) / rate, audio).astype(np.float32)


class Lines:
    """A session's spoken lines that have not reached the service yet, in the order they were typed."""

    def __init__(self):
        self._pending = np.zeros(0, dtype=np.float32)

    def add(self, pcm: np.ndarray) -> None:
        self._pending = np.concatenate((self._pending, pcm))

    def mix(self, pcm: np.ndarray) -> np.ndarray:
        """The person's audio with as much of the lines as fits in it added."""
        if not len(self._pending):
            return pcm
        n = min(len(pcm), len(self._pending))
        mixed = pcm.astype(np.float32, copy=True)
        mixed[:n] += self._pending[:n]
        self._pending = self._pending[n:]
        return mixed
