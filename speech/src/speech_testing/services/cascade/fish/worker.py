"""Fish Audio S2 Pro as a process: lines of text in, speech out.

Run by `speech_testing.services.cascade.voice` inside this folder's
environment. The protocol is in `../pipe.py`.

S2 Pro clones a voice in context: each line is generated after the clip and
the words said in it, so a request carries the clip's transcript. Without a
clip the model would pick a new voice for every line, so the worker makes one
line in a voice of the model's choosing and uses that as the clip.
"""

from __future__ import annotations

import functools
import io
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from pipe import Pipe  # noqa: E402

REPO = "fishaudio/s2-pro"
RATE = 24_000  # what the app plays; the model makes 44.1 kHz
CLIP_SECONDS = 20  # of a voice clip the model is shown; more slows every line
# Tags the model card lists, and ones for crying. Any short description in brackets works.
TAGS = ["laughing", "chuckle", "sigh", "gasp", "sobbing", "crying", "sniffling", "whisper", "clearing throat",
        "inhale", "exhale", "excited", "sad", "angry", "surprised", "shouting"]
# The model's context is 32,768 tokens, and it sets aside memory for all of it: about 4 GB.
# A line with its voice clip is a few hundred tokens, and the model wants 2,048 spare.
CONTEXT = 4096
OWN_VOICE = "Hi there, it is really good to talk to you today. Tell me, what is on your mind?"
OWN_SEED = 7


def main() -> None:
    pipe = Pipe()
    import soundfile as sf
    import torch
    from huggingface_hub import snapshot_download, try_to_load_from_cache

    if not isinstance(try_to_load_from_cache(REPO, "codec.pth"), str):
        pipe.status("Downloading the voice model, about 11 GB")
    checkpoint = Path(snapshot_download(REPO, allow_patterns=["*.json", "*.safetensors", "*.pth", "*.jinja"]))

    import fish_speech
    from fish_speech.inference_engine import TTSInferenceEngine
    from fish_speech.models.text2semantic import inference as text2semantic
    from fish_speech.models.text2semantic.inference import launch_thread_safe_queue
    from fish_speech.utils.schema import ServeReferenceAudio, ServeTTSRequest
    from hydra import compose, initialize_config_dir
    from hydra.utils import instantiate
    from scipy.signal import resample_poly

    device = "cuda" if torch.cuda.is_available() else "cpu"
    precision = torch.bfloat16
    compiled = os.environ.get("CASCADE_FISH_COMPILE", "1") != "0" and device == "cuda"
    pipe.status("Loading the voice model" + (" and compiling it, a few minutes" if compiled else ""))
    # The loader takes no context length, but the model's own from_pretrained does.
    load = text2semantic.DualARTransformer.from_pretrained
    text2semantic.DualARTransformer.from_pretrained = staticmethod(
        functools.partial(load, max_length=int(os.environ.get("CASCADE_FISH_CONTEXT", CONTEXT))))
    llama = launch_thread_safe_queue(checkpoint_path=str(checkpoint), device=device, precision=precision,
                                     compile=compiled)
    # The codec, loaded as fish_speech.models.dac.inference.load_model does. That module
    # cannot be imported from an installed package: it looks for the repo's root at import.
    with initialize_config_dir(config_dir=str(Path(fish_speech.__path__[0]) / "configs"), version_base="1.3"):
        codec = instantiate(compose(config_name="modded_dac_vq"))
    state = torch.load(checkpoint / "codec.pth", map_location=device, mmap=True, weights_only=True)
    state = state.get("state_dict", state)
    if any("generator" in key for key in state):
        state = {key.replace("generator.", ""): value for key, value in state.items() if "generator." in key}
    codec.load_state_dict(state, strict=False, assign=True)
    codec.eval().to(device)
    engine = TTSInferenceEngine(llama_queue=llama, decoder_model=codec, precision=precision, compile=compiled)

    def generate(text: str, references: list, temperature: float, seed: int | None = None):
        """`text` as speech at the model's own sample rate."""
        request = ServeTTSRequest(text=text, references=references, use_memory_cache="on", seed=seed,
                                  temperature=min(1.0, max(0.1, temperature)))
        for result in engine.inference(request):
            if result.code == "error":
                raise result.error
            if result.code == "final":
                return result.audio
        raise RuntimeError("the model made no audio")

    def wav(audio, rate: int) -> bytes:
        file = io.BytesIO()
        sf.write(file, audio, rate, format="WAV", subtype="PCM_16")
        return file.getvalue()

    clips: dict[tuple[str, float], bytes] = {}  # a voice clip cut to length, by path and time changed

    def clip(path: str) -> bytes:
        key = (path, os.path.getmtime(path))
        if key not in clips:
            audio, rate = sf.read(path, dtype="float32", always_2d=True)
            clips[key] = wav(audio.mean(axis=1)[: CLIP_SECONDS * rate], rate)
        return clips[key]

    rate, audio = generate(OWN_VOICE, [], 0.7, OWN_SEED)  # also the warm-up, and the compile
    own = ServeReferenceAudio(audio=wav(audio, rate), text=OWN_VOICE)

    def speak(request: dict) -> bytes:
        reference = own
        if request.get("voice"):
            reference = ServeReferenceAudio(audio=clip(request["voice"]), text=request.get("voice_text") or "")
        rate, audio = generate(request["text"], [reference], float(request.get("temperature", 0.7)))
        return resample_poly(audio, RATE, rate).astype("<f4").tobytes()

    pipe.serve(speak, sample_rate=RATE, tags=TAGS, free_tags=True, transcript=True, clip_seconds=CLIP_SECONDS)


if __name__ == "__main__":
    main()
