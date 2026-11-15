"""Stable Audio Open 1.0 as a process: sound effect requests in, audio files out.

Run by server/sound.ts inside this folder's environment. The protocol is in
`../pipe.py`. The weights, about 6 GB, download to the Hugging Face cache the
first time.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipe import Pipe, save  # noqa: E402

# Stability's own repo needs a Hugging Face login and a click on its licence. This
# is a byte-for-byte copy without that, which the licence allows, pinned so it can't change.
REPO = "RedbeardNZ/stable-audio-open-1.0"
REVISION = "308b7b7d38ef375a14d88e914652d1ab2b61cd56"
LONGEST = 47.0
STEPS = 100


def main() -> None:
    pipe = Pipe()
    import torch
    from diffusers import StableAudioPipeline
    from huggingface_hub import try_to_load_from_cache

    if not isinstance(try_to_load_from_cache(REPO, "transformer/diffusion_pytorch_model.safetensors", revision=REVISION), str):
        pipe.status("Downloading Stable Audio Open's weights, about 6 GB")
    model = StableAudioPipeline.from_pretrained(REPO, revision=REVISION, torch_dtype=torch.float16).to("cuda")
    model.set_progress_bar_config(disable=True)
    sample_rate = model.vae.sampling_rate

    def make(request: dict) -> list[dict]:
        steps = int(request.get("steps") or STEPS)
        seconds = min(float(request["seconds"]) or 6.0, LONGEST)
        takes = int(request["takes"])
        seed = int(request["seed"])
        tracks = []
        # One take at a time, each with its own seed, so a seed always makes the same sound.
        for take in range(takes):
            generator = torch.Generator("cuda").manual_seed(seed + take)
            audio = model(
                request["prompt"],
                negative_prompt="low quality, average quality, music",
                audio_end_in_s=seconds,
                num_inference_steps=steps,
                guidance_scale=7.0,
                generator=generator,
                callback=lambda step, *_: pipe.progress((take + (step + 1) / steps) / takes),
                callback_steps=1,
            ).audios[0]
            samples = audio.T.float().cpu().numpy()[: round(seconds * sample_rate)]
            tracks.append(save(request, take, samples, sample_rate, seed + take))
        return tracks

    pipe.serve(make)


if __name__ == "__main__":
    main()
