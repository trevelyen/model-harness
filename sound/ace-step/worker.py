"""ACE-Step 1.5 as a process: song and instrumental requests in, audio files out.

Run by server/sound.ts inside this folder's environment. The protocol is in
`../pipe.py`. Weights go in `checkpoints/` here, about 10 GB, downloaded the
first time.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
from pipe import Pipe, save  # noqa: E402

CHECKPOINTS = HERE / "checkpoints"
os.environ.setdefault("ACESTEP_CHECKPOINTS_DIR", str(CHECKPOINTS))
os.environ.setdefault("ACESTEP_PROJECT_ROOT", str(HERE))

# The 2B turbo model makes a song in 8 steps. The 1.7B language model plans it
# first: tempo, key, structure, and the lyrics' timing.
DIT = "acestep-v15-turbo"
LM = "acestep-5Hz-lm-1.7B"


def main() -> None:
    pipe = Pipe()
    from acestep.model_downloader import ensure_main_model

    if not (CHECKPOINTS / DIT).is_dir():
        pipe.status("Downloading ACE-Step's weights, about 10 GB")
    ok, message = ensure_main_model(CHECKPOINTS)
    if not ok:
        raise SystemExit(f"Could not download ACE-Step: {message}")

    pipe.status("Loading ACE-Step")
    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music
    from acestep.llm_inference import LLMHandler

    dit = AceStepHandler()
    message, ok = dit.initialize_service(project_root=str(HERE), config_path=DIT, device="cuda")
    if not ok:
        raise SystemExit(f"ACE-Step did not load: {message}")
    lm = LLMHandler()
    # "pt" rather than its vLLM, which claims most of the GPU's free memory for itself
    # and would starve llama-server.
    message, ok = lm.initialize(checkpoint_dir=str(CHECKPOINTS), lm_model_path=LM, backend="pt", device="cuda")
    if not ok:
        raise SystemExit(f"ACE-Step's language model did not load: {message}")

    def make(request: dict) -> list[dict]:
        song = request["mode"] == "song"
        params = GenerationParams(
            caption=request["prompt"][:512],
            lyrics=(request["lyrics"] or "")[:4096] if song else "[Instrumental]",
            instrumental=not song,
            duration=float(request["seconds"]) if request["seconds"] else -1.0,
            inference_steps=int(request.get("steps") or 8),
            shift=3.0,  # what the turbo model was trained with; the default of 1 isn't
            seed=int(request["seed"]),
        )
        takes = int(request["takes"])
        config = GenerationConfig(
            batch_size=takes,
            use_random_seed=False,
            seeds=[int(request["seed"]) + i for i in range(takes)],
            audio_format="wav",
        )
        # Its progress runs from about 0.5, when the model starts, to 1.
        result = generate_music(dit, lm, params, config, save_dir=None,
                                progress=lambda value, desc=None, **_: pipe.progress((value - 0.5) * 2))
        if not result.success:
            raise RuntimeError(result.error or "ACE-Step made nothing")
        tracks = []
        for take, audio in enumerate(result.audios):
            samples = audio["tensor"].numpy().T  # (channels, samples) → (samples, channels)
            tracks.append(save(request, take, samples, audio["sample_rate"], int(audio["params"].get("seed", request["seed"] + take))))
        return tracks

    pipe.serve(make)


if __name__ == "__main__":
    main()
