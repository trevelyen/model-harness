"""The listening half: when the person is talking, and what they said.

`Listener` follows the person's audio with Silero VAD and reports the moments
a conversation turns on: they have been talking long enough to mean it, they
paused, they went on, they stopped. `Whisper` turns a stretch of speech into
text. Both work at 16 kHz; `Downsampler` brings the session's 24 kHz down.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass

import numpy as np

from ..base import Progress

RATE = 16_000
WINDOW = 512  # samples the VAD takes at a time, 32 ms
WINDOW_SECONDS = WINDOW / RATE
SPEECH = 0.5  # VAD probability from which a window counts as speech
ONSET = 2  # windows of speech in a row that start an utterance
LEAD_IN = 10  # windows kept from before the onset, so the first word is whole
SUSTAINED = 0.35  # seconds of speech after which the person means to talk, not just "mm-hm"
SHORTEST = 0.2  # seconds of speech below which an utterance is taken for noise
EARLY = 0.2  # seconds of quiet after which transcription starts, before the pause is over
LONGEST = 60.0  # seconds an utterance may run before it is cut


class Downsampler:
    """24 kHz to 16 kHz as the audio arrives: a low-pass, then two samples out for every three in."""

    def __init__(self):
        from scipy.signal import firwin

        self._taps = firwin(63, 7200, fs=24_000)
        self._state = np.zeros(len(self._taps) - 1)
        self._held = np.zeros(0, dtype=np.float32)

    def __call__(self, pcm: np.ndarray) -> np.ndarray:
        from scipy.signal import lfilter

        filtered, self._state = lfilter(self._taps, 1.0, pcm, zi=self._state)
        samples = np.concatenate((self._held, filtered.astype(np.float32)))
        whole = len(samples) // 3 * 3
        triples = samples[:whole].reshape(-1, 3)
        self._held = samples[whole:]
        out = np.empty((len(triples), 2), dtype=np.float32)
        out[:, 0] = triples[:, 0]
        out[:, 1] = (triples[:, 1] + triples[:, 2]) / 2
        return out.reshape(-1)


@dataclass(frozen=True)
class Sustained:
    """The person has talked for long enough to mean it."""


@dataclass(frozen=True)
class Paused:
    """They went quiet, perhaps for good."""

    audio: np.ndarray  # the utterance so far, at 16 kHz


@dataclass(frozen=True)
class Resumed:
    """They went on after a pause."""


@dataclass(frozen=True)
class Ended:
    """They stopped."""

    audio: np.ndarray  # the whole utterance, at 16 kHz
    sustained: bool
    quiet: float  # seconds since their last word


Signal = Sustained | Paused | Resumed | Ended


class Listener:
    """One session's ear. `hear()` takes audio at 24 kHz and returns what just happened, in order."""

    def __init__(self, pause: float):
        from silero_vad import load_silero_vad

        self._vad = load_silero_vad()
        self._down = Downsampler()
        self._pause = pause  # seconds of quiet that end an utterance
        self._pending = np.zeros(0, dtype=np.float32)
        self._before: deque[np.ndarray] = deque(maxlen=LEAD_IN)
        self.reset()

    def reset(self) -> None:
        """Forget the utterance under way."""
        self._utterance: list[np.ndarray] | None = None
        self._run = 0  # windows of speech in a row, before an utterance
        self._voiced = self._quiet = 0  # windows of speech in the utterance, and of quiet at its end
        self._sustained = self._paused = False

    def hear(self, pcm: np.ndarray) -> list[Signal]:
        import torch

        signals: list[Signal] = []
        self._pending = np.concatenate((self._pending, self._down(pcm)))
        while len(self._pending) >= WINDOW:
            window, self._pending = self._pending[:WINDOW], self._pending[WINDOW:]
            with torch.no_grad():
                speech = self._vad(torch.from_numpy(window), RATE).item() >= SPEECH
            self._window(window, speech, signals)
        return signals

    def _window(self, window: np.ndarray, speech: bool, signals: list[Signal]) -> None:
        if self._utterance is None:
            self._before.append(window)
            self._run = self._run + 1 if speech else 0
            if self._run < ONSET:
                return
            self._utterance = list(self._before)
            self._before.clear()
            self._voiced, self._quiet = ONSET, 0
            return
        self._utterance.append(window)
        if speech:
            self._voiced += 1
            self._quiet = 0
            if self._paused:
                self._paused = False
                signals.append(Resumed())
            if not self._sustained and self._voiced * WINDOW_SECONDS >= SUSTAINED:
                self._sustained = True
                signals.append(Sustained())
        else:
            self._quiet += 1
        quiet = self._quiet * WINDOW_SECONDS
        long_enough = self._voiced * WINDOW_SECONDS >= SHORTEST
        if quiet >= self._pause or len(self._utterance) * WINDOW_SECONDS >= LONGEST:
            if long_enough:
                signals.append(Ended(np.concatenate(self._utterance), self._sustained, quiet))
            self.reset()
        elif quiet >= EARLY and long_enough and not self._paused and self._pause > EARLY:
            self._paused = True
            signals.append(Paused(np.concatenate(self._utterance)))


class Whisper:
    """Whisper large-v3-turbo through transformers, loaded at the first session and kept."""

    REPO = "openai/whisper-large-v3-turbo"
    LONGEST = 30 * RATE  # samples the model takes at once

    def __init__(self):
        self._model = self._processor = None
        self._lock = asyncio.Lock()  # one transcription at a time, in the order asked

    def loaded(self) -> bool:
        return self._model is not None

    async def load(self, progress: Progress) -> None:
        if self._model is not None:
            return
        from huggingface_hub import try_to_load_from_cache

        downloaded = isinstance(try_to_load_from_cache(self.REPO, "model.safetensors"), str)
        await progress("Loading speech recognition" if downloaded else "Downloading speech recognition, about 1.6 GB")
        await asyncio.to_thread(self._load)

    def _load(self) -> None:
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor

        device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        dtype = torch.float32 if device == "cpu" else torch.float16
        processor = WhisperProcessor.from_pretrained(self.REPO)
        model = WhisperForConditionalGeneration.from_pretrained(self.REPO, dtype=dtype).to(device).eval()
        self._processor, self._model = processor, model
        self._transcribe(np.zeros(RATE, dtype=np.float32))  # the first run is slow

    async def transcribe(self, audio: np.ndarray) -> str:
        """What is said in `audio`, mono float32 at 16 kHz."""
        async with self._lock:
            return await asyncio.to_thread(self._transcribe, audio)

    def _transcribe(self, audio: np.ndarray) -> str:
        import torch

        model, processor = self._model, self._processor
        parts = []
        for start in range(0, len(audio), self.LONGEST):
            features = processor(audio[start : start + self.LONGEST], sampling_rate=RATE, return_tensors="pt").input_features
            with torch.inference_mode():
                ids = model.generate(features.to(model.device, model.dtype), language="en", task="transcribe", max_new_tokens=200)
            parts.append(processor.batch_decode(ids, skip_special_tokens=True)[0].strip())
        return " ".join(part for part in parts if part)
