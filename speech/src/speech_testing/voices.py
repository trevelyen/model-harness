"""The voice library: the reference clips a service can be asked to speak with.

A voice is one mono WAV file named by its id. Services never see uploads or
names, only the path of a stored clip.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass
from pathlib import Path

import soundfile as sf

ID = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
MAX_BYTES = 64 << 20
MIN_SECONDS, MAX_SECONDS = 1.0, 600.0


class VoiceError(ValueError):
    """A voice request that cannot be met; the message is shown to the person."""


@dataclass(frozen=True)
class Voice:
    id: str
    seconds: float

    def describe(self) -> dict:
        return {"id": self.id, "seconds": round(self.seconds, 2)}


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:48].strip("-")


class VoiceStore:
    def __init__(self, root: Path):
        self.root = root

    def list(self) -> list[Voice]:
        voices = []
        for path in sorted(self.root.glob("*.wav")):
            if not ID.fullmatch(path.stem):
                continue
            try:
                info = sf.info(str(path))
            except Exception:
                continue
            voices.append(Voice(path.stem, info.frames / info.samplerate))
        return voices

    def path(self, voice_id: str) -> Path:
        """The clip of a voice. The id is checked before it becomes a path."""
        if not ID.fullmatch(voice_id):
            raise VoiceError("There is no such voice.")
        path = self.root / f"{voice_id}.wav"
        if not path.is_file():
            raise VoiceError(f"The voice {voice_id} is no longer in the library.")
        return path

    def add(self, name: str, data: bytes) -> Voice:
        """Store an audio file as a new voice, mixed down to mono."""
        if len(data) > MAX_BYTES:
            raise VoiceError("That file is too large for a voice clip.")
        try:
            wave, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
        except Exception as error:
            raise VoiceError("That file is not audio this app can read (WAV, FLAC, Ogg or MP3).") from error
        mono = wave.mean(axis=1)
        seconds = len(mono) / rate
        if not MIN_SECONDS <= seconds <= MAX_SECONDS:
            raise VoiceError(f"A voice clip is between {MIN_SECONDS:g} seconds and {MAX_SECONDS / 60:g} minutes long.")
        base = _slug(name) or "voice"
        voice_id, n = base, 2
        while (self.root / f"{voice_id}.wav").exists():
            voice_id, n = f"{base}-{n}", n + 1
        self.root.mkdir(parents=True, exist_ok=True)
        sf.write(str(self.root / f"{voice_id}.wav"), mono, rate, subtype="PCM_16")
        return Voice(voice_id, seconds)

    def remove(self, voice_id: str) -> None:
        self.path(voice_id).unlink()
