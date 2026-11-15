"""YuE2-3B as a process: song requests in, audio files out.

Run by server/sound.ts inside this folder's environment. The protocol is in
`../pipe.py`. The weights, about 8 GB, download to the Hugging Face cache the
first time.

It runs in low_vram mode: only the half of the model at work sits on the GPU,
at full precision, so it fits beside llama-server. YuE2 decides how long a song
is from its lyrics; there's no length to ask for.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipe import Pipe, save  # noqa: E402

MODEL = "m-a-p/YuE2-3B"
VAE = "m-a-p/YuE2-Vae"
# How many tokens a song usually takes, for a progress estimate: about three minutes.
TYPICAL_TOKENS = 4500
# How far along each stage leaves the job. Writing the song's tokens takes most of the time.
PLAN, WRITE, SYNTHESIZE = 0.05, 0.75, 0.92


def main() -> None:
    pipe = Pipe()
    from huggingface_hub import try_to_load_from_cache
    from yue2 import YuE2Pipeline

    if not isinstance(try_to_load_from_cache(MODEL, "model.safetensors"), str):
        pipe.status("Downloading YuE2's weights, about 8 GB")
    model = YuE2Pipeline.from_pretrained(MODEL, vae=VAE, device="cuda", low_vram=True, memory_budget_gib=10, progress=False)

    def make(request: dict) -> list[dict]:
        takes = int(request["takes"])
        tracks = []
        for take in range(takes):
            seed = int(request["seed"]) + take
            written = 0

            def on_token(phase, _token, take=take):
                nonlocal written
                if phase == "semantic":
                    written += 1
                    done = PLAN + (WRITE - PLAN) * min(written / TYPICAL_TOKENS, 1)
                else:
                    done = PLAN / 2
                pipe.progress((take + done) / takes)

            def on_progress(stage, done, total, take=take):
                start, end = (WRITE, SYNTHESIZE) if stage == "nar" else (SYNTHESIZE, 1.0)
                pipe.progress((take + start + (end - start) * done / max(total, 1)) / takes)

            song = model(style=request["prompt"], lyrics=request["lyrics"] or "", seed=seed,
                         on_token=on_token, on_progress=on_progress)
            tracks.append(save(request, take, song.audio, song.sample_rate, seed))
        return tracks

    pipe.serve(make)


if __name__ == "__main__":
    main()
