"""A voice worker's end of the pipes it shares with the app.

Each voice model runs as a process in an environment of its own (see
`voice.py`), and its worker script imports this file by path. It uses only
the standard library, since it runs in whichever environment the worker has.

Requests arrive on stdin, one JSON object per line:

    {"op": "speak", "id": 7, "text": "...", "voice": "/path/clip.wav" or null,
     "voice_text": "what the clip says", "temperature": 0.8}
    {"op": "cancel", "upto": 7}      drop every speak with an id up to this one

Answers leave on stdout, one JSON object per line. An `audio` answer is
followed by its samples: `bytes` bytes of mono float32, little endian, at the
sample rate the worker gave when it became ready.

    {"event": "status", "text": "Downloading the voice model, about 11 GB"}   before ready, any number
    {"event": "ready", "sample_rate": 24000, "tags": [...], "free_tags": false, "transcript": false}
    {"event": "audio", "id": 7, "bytes": 96000}
    {"event": "done", "id": 7, "seconds": 0.31}
    {"event": "error", "id": 7, "message": "..."}

Everything the libraries print goes to stderr, so stdout carries only answers.
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from typing import Callable


class Pipe:
    def __init__(self):
        self._answers = os.fdopen(os.dup(1), "wb")
        os.dup2(2, 1)  # whatever a library prints
        self._speaks: queue.Queue[dict | None] = queue.Queue()
        self._cancelled = -1

    def answer(self, event: dict, payload: bytes = b"") -> None:
        self._answers.write(json.dumps(event).encode() + b"\n" + payload)
        self._answers.flush()

    def status(self, text: str) -> None:
        self.answer({"event": "status", "text": text})

    def serve(self, speak: Callable[[dict], bytes], **ready) -> None:
        """Say the model is ready, then answer requests until the app closes stdin.

        `speak` takes a request and returns its speech as float32 bytes.
        """
        # stdin is read on a thread, so a cancel is seen while a line is being spoken.
        threading.Thread(target=self._read, daemon=True).start()
        self.answer({"event": "ready", **ready})
        while (request := self._speaks.get()) is not None:
            number = request.get("id")
            try:
                began = time.perf_counter()
                if number > self._cancelled:
                    pcm = speak(request)
                    if number > self._cancelled:
                        self.answer({"event": "audio", "id": number, "bytes": len(pcm)}, pcm)
                self.answer({"event": "done", "id": number, "seconds": time.perf_counter() - began})
            except Exception as error:
                self.answer({"event": "error", "id": number, "message": str(error) or type(error).__name__})

    def _read(self) -> None:
        for line in sys.stdin:
            try:
                request = json.loads(line)
            except ValueError:
                continue
            if request.get("op") == "cancel":
                self._cancelled = max(self._cancelled, int(request.get("upto", -1)))
            elif request.get("op") == "speak":
                self._speaks.put(request)
        self._speaks.put(None)  # the app closed stdin: stop
