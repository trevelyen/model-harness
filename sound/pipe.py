"""A sound worker's end of the pipes it shares with the app (server/sound.ts).

Each model runs as a process in an environment of its own, in a folder beside
this file, and its `worker.py` imports this by path. It uses only the standard
library, since it runs in whichever environment the worker has.

Requests arrive on stdin, one JSON object per line:

    {"op": "make", "id": 3, "mode": "song" | "instrumental" | "effect",
     "prompt": "...", "lyrics": "...", "seconds": 120 (0 lets the model choose),
     "takes": 2, "steps": 8 or null, "seed": 1234 or null, "format": "wav" | "flac",
     "folder": "/abs/data/sound/<chat>", "name": "lx3k2-3"}

Answers leave on stdout, one JSON object per line:

    {"event": "status", "text": "Downloading the weights"}   before ready, any number
    {"event": "ready"}
    {"event": "progress", "id": 3, "value": 0.42}
    {"event": "done", "id": 3, "tracks": [{"file": "lx3k2-3-0.wav", "seconds": 121.4, "seed": 1234}]}
    {"event": "error", "id": 3, "message": "..."}

Everything the libraries print goes to stderr, so stdout carries only answers.
Closing stdin ends the worker.
"""

from __future__ import annotations

import json
import os
import random
import sys
from typing import Callable


class Pipe:
    def __init__(self):
        self._answers = os.fdopen(os.dup(1), "w")
        os.dup2(2, 1)  # whatever a library prints
        sys.stdout = sys.stderr
        self.job: int | None = None

    def answer(self, event: dict) -> None:
        self._answers.write(json.dumps(event) + "\n")
        self._answers.flush()

    def status(self, text: str) -> None:
        self.answer({"event": "status", "text": text})

    def progress(self, value: float) -> None:
        """How far the current job is, from 0 to 1."""
        if self.job is not None:
            self.answer({"event": "progress", "id": self.job, "value": round(min(max(value, 0.0), 1.0), 3)})

    def serve(self, make: Callable[[dict], list[dict]]) -> None:
        """Say the model is ready, then make sounds until the app closes stdin.

        `make` takes a request, with `seed` always set, and returns its tracks.
        """
        self.answer({"event": "ready"})
        for line in sys.stdin:
            try:
                request = json.loads(line)
            except ValueError:
                continue
            if request.get("op") != "make":
                continue
            self.job = request["id"]
            if request.get("seed") is None:
                request["seed"] = random.randrange(2**31)
            try:
                self.answer({"event": "done", "id": self.job, "tracks": make(request)})
            except Exception as error:  # noqa: BLE001 - the app shows it
                import traceback

                traceback.print_exc()
                self.answer({"event": "error", "id": self.job, "message": str(error) or type(error).__name__})
            finally:
                self.job = None


def save(request: dict, take: int, audio, sample_rate: int, seed: int) -> dict:
    """Writes one take to the request's folder. `audio` is (samples,) or (samples, channels) float."""
    import soundfile as sf

    name = f"{request['name']}-{take}.{request['format']}"
    sf.write(os.path.join(request["folder"], name), audio, sample_rate)
    return {"file": name, "seconds": round(len(audio) / sample_rate, 2), "seed": seed}
