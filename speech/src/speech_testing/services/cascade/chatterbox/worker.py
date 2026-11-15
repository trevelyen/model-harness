"""Chatterbox Turbo as a process: lines of text in, speech out.

Run by `speech_testing.services.cascade.voice` inside this folder's
environment. The protocol is in `../pipe.py`.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipe import Pipe  # noqa: E402

# The sounds Turbo makes from a tag in the text. Measured with an AudioSet classifier,
# its sighs and gasps are clear, its laughs faint, and [crying] changes nothing.
TAGS = ["laugh", "chuckle", "sigh", "gasp", "cough", "clear throat", "sniff", "groan"]
WARM_UP = "Hello there."
SHORTEST = 5.2  # seconds: the model refuses a clip of 5.0 or less, so one that short gets silence added


def main() -> None:
    pipe = Pipe()
    import numpy as np
    import torch
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    own_voice = model.conds
    voices: dict[tuple[str, float], object] = {}  # a clip's conditionals, by path and time changed

    def use(voice: str | None) -> None:
        if not voice:
            model.conds = own_voice
            return
        key = (voice, os.path.getmtime(voice))
        if key not in voices:
            import soundfile as sf

            info = sf.info(voice)
            if info.frames < SHORTEST * info.samplerate:
                audio, rate = sf.read(voice, dtype="float32", always_2d=True)
                audio = np.concatenate((audio, np.zeros((round(SHORTEST * rate) - len(audio), audio.shape[1]), "float32")))
                with tempfile.NamedTemporaryFile(suffix=".wav") as padded:
                    sf.write(padded.name, audio, rate)
                    model.prepare_conditionals(padded.name)
            else:
                model.prepare_conditionals(voice)
            voices[key] = model.conds
        model.conds = voices[key]

    def speak(request: dict) -> bytes:
        use(request.get("voice"))
        with torch.inference_mode():
            wave = model.generate(request["text"], temperature=float(request.get("temperature", 0.8)))
        return wave.squeeze(0).numpy().astype("<f4").tobytes()

    with torch.inference_mode():
        model.generate(WARM_UP)
    pipe.serve(speak, sample_rate=model.sr, tags=TAGS, free_tags=False, transcript=False)


if __name__ == "__main__":
    main()
