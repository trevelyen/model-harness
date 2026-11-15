"""Cascade: a duplex conversation built from three models that can each be swapped.

Speech recognition hears the person (`hearing.py`), a language model of the
person's choosing writes the reply (`llm.py`), and a voice model speaks it in
a cloned voice (`voice.py`). The session below wires them so the whole behaves
like a duplex model: it listens while it speaks, stops when the person cuts
in, and remembers only as much of its reply as they heard. The words are the
language model's alone, so the fillers, the laughing and the crying are asked
for in its prompt and written by it, as text the voice model acts out.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Callable

import aiohttp
import numpy as np
import soundfile as sf

from ...fields import ChoiceField, Field, NumberField, TextField, ToggleField, VoiceField
from ...voices import VoiceError, VoiceStore
from ..base import Audio, Event, Heard, Interrupt, Kind, Progress, Report, ServiceError, Status, Text
from .hearing import RATE as HEARING_RATE
from .hearing import Ended, Listener, Paused, Resumed, Sustained, Whisper
from .llm import Chunker, Llm, speakable
from .voice import SAMPLE_RATE, Synth

logger = logging.getLogger(__name__)

DEFAULT_URL = "http://127.0.0.1:8080/v1"
VOICE_SECONDS = (5.0, 180.0)  # the shortest and longest clip a voice is cloned from
LEAD = 0.4  # seconds of audio sent ahead of what the person has heard
CHARACTER = (
    "You are Juno, a warm, quick-witted friend on a voice call. You are curious about the person you "
    "are talking to, you tease them a little, and you say what you actually think."
)
SPOKEN = (
    "This is a live voice conversation: everything you write is spoken aloud, and what the person says "
    "reaches you as a transcript that may mishear a word. Write only the words you say. No lists, no "
    "markdown, no emoji, no stage directions. Keep a reply to a sentence or three unless asked for more. "
    "The person can cut in while you talk; a reply of yours that ends with — was cut off there."
)
FILLERS = (
    "Talk the way people do when they think out loud. Use fillers and hesitations such as um, uh, like, "
    "you know, I mean, hmm and well where a person would, and now and then restart a sentence. Not in "
    "every sentence."
)
OPENING = "(The call has just connected. Say hello.)"


def _sounds(synth: Synth) -> str:
    """The paragraph of the prompt that says which sounds the voice model can make."""
    tags = synth.tags
    offered = ", ".join(f"[{tag}]" for tag in tags)
    laugh = next(tag for tag in tags if tag.startswith("laugh"))
    cry = next((tag for tag in tags if tag in ("sobbing", "crying")), None)
    example = f"[{laugh}] No way, you did not!"
    if cry:
        example += f" Or: [{cry}] I just miss her so much."
    more = ("Any short description in brackets works too, such as [voice breaking]."
            if synth.free_tags else "Write no other tags.")
    return (
        "You can make sounds and change how you sound by writing a tag where it happens. These work: "
        f"{offered}. For example: {example} Use one when the moment calls for it, not in every reply. {more}"
    )


class Cascade:
    id = "cascade"
    name = "Cascade"
    kind = Kind.DUPLEX
    summary = ("Speech recognition, a language model of your choosing and a voice model that clones a "
               "voice, wired together to talk like a duplex model.")
    sample_rate = SAMPLE_RATE
    ahead = True  # a sentence arrives whole, ahead of its playing

    def __init__(self, voices: VoiceStore):
        self._voices = voices
        self._whisper = Whisper()
        self._synths = (
            Synth("s2pro", "S2 Pro (Fish Audio): laughs and cries; non-commercial licence", "fish"),
            Synth("chatterbox", "Chatterbox Turbo (Resemble AI): lighter and quicker; sighs, barely laughs", "chatterbox"),
        )
        self._transcripts: dict[tuple[Path, float, float], str] = {}  # what a clip says, by path, time changed and length heard
        self._busy = False  # one conversation at a time: they would share the voice model

    def fields(self) -> list[Field]:
        return [
            TextField(
                "llm_url", "Language model", default=os.environ.get("CASCADE_LLM_URL", DEFAULT_URL),
                help="The address of any server that speaks OpenAI's chat completions: llama-server, "
                "Ollama, vLLM or a hosted API. Its key, if it needs one, is read from CASCADE_LLM_API_KEY.",
            ),
            TextField("llm_model", "Model", default=os.environ.get("CASCADE_LLM_MODEL", ""),
                      help="The model's name on that server. Left empty, the first one it lists."),
            # model-harness fills the three language model fields from the model picked in the app.
            TextField("llm_key", "Key", help="The language model server's key, if it needs one."),
            ToggleField("thinks", "Thinks before it answers",
                        help="Let a reasoning model reason. It is asked not to otherwise, since the person waits."),
            TextField("character", "Character", default=CHARACTER, multiline=True,
                      help="Who it is and how it talks. How to speak, pause and make sounds is added to this."),
            ChoiceField("voice_model", "Voice model", default="chatterbox",
                        options=tuple((synth.id, synth.label) for synth in self._synths),
                        help="Only one is kept loaded; changing it loads the other at the next start. "
                        "S2 Pro's weights are for research and non-commercial use only."),
            VoiceField("voice", "Voice",
                       help="One speaker, 5 seconds to 3 minutes of clean speech. The first 15 to 20 "
                       "seconds set the voice. Without one it speaks in a voice of the model's own."),
            ToggleField("fillers", "Fillers", default=True, help="Ask for um, uh, like and restarts."),
            ToggleField("sounds", "Sounds", default=True,
                        help="Let it laugh, sigh, gasp and, with S2 Pro, cry."),
            NumberField("temperature", "Temperature", 0.8, 0.0, 1.5, 0.05, help="Of the language model."),
            NumberField("liveliness", "Voice liveliness", 0.8, 0.3, 1.2, 0.05,
                        help="The voice model's temperature: higher is more varied, lower is steadier."),
            NumberField("pause", "Pause before it answers", 0.6, 0.3, 2.0, 0.1,
                        help="Seconds of quiet after which you are taken to have finished."),
            ToggleField("interruptible", "Stops when you cut in", default=True,
                        help="Off, it does not listen while it talks. For speakers without echo cancelling."),
            ToggleField("speak_first", "It speaks first"),
        ]

    def status(self) -> Status:
        if reason := self._synths[0].unavailable():
            return Status(False, reason)
        if loaded := next((synth for synth in self._synths if synth.loaded()), None):
            return Status(True, f"{loaded.label.split(':')[0]} is loaded.")
        if any(synth.installed() for synth in self._synths):
            return Status(True, "Its models load at the first start.")
        return Status(True, "The first start installs the voice model and downloads the models, many GB.")

    async def open(self, settings: dict[str, Any], progress: Progress) -> "CascadeSession":
        synth = next(synth for synth in self._synths if synth.id == settings["voice_model"])
        if reason := synth.unavailable():
            raise ServiceError(reason)
        if self._busy:
            raise ServiceError("Cascade is already in a conversation.")
        self._busy = True
        http = aiohttp.ClientSession()
        try:
            voice = self._clip(settings["voice"]) if settings["voice"] else None
            llm = Llm(http, settings["llm_url"].strip() or DEFAULT_URL,
                      settings["llm_key"] or os.environ.get("CASCADE_LLM_API_KEY", ""),
                      settings["llm_model"].strip(), settings["thinks"])
            await progress("Finding the language model")
            listed = await llm.models()
            if not llm.model:
                if not listed:
                    raise ServiceError(f"The server at {llm.url} lists no models; name one in the Model setting.")
                llm.model = listed[0]
            await self._whisper.load(progress)
            for other in self._synths:
                if other is not synth:
                    await other.stop()  # two voice models would not fit beside a language model
            await synth.start(progress)
            await progress("Preparing the voice")
            said = await self._transcript(voice, synth.clip_seconds) if voice and synth.transcript else ""
            await synth.speak("Okay.", voice, settings["liveliness"], said)  # works out the clip's voice, once
            return CascadeSession(self._whisper, synth, llm, http, settings, voice, said, self._free)
        except Exception as error:
            await http.close()
            self._free()
            if isinstance(error, (ServiceError, VoiceError)):
                raise
            logger.exception("cascade could not start")
            raise ServiceError(f"Cascade could not start: {error}") from error
        except BaseException:
            await http.close()
            self._free()
            raise

    def _free(self) -> None:
        self._busy = False

    def _clip(self, voice_id: str) -> Path:
        path = self._voices.path(voice_id)
        info = sf.info(str(path))
        seconds = info.frames / info.samplerate
        shortest, longest = VOICE_SECONDS
        if not shortest <= seconds <= longest + 0.5:
            raise ServiceError(f"The voice is {seconds:.1f} s long; a voice is cloned from a clip of "
                               f"{shortest:g} seconds to {longest / 60:g} minutes.")
        return path

    async def _transcript(self, path: Path, seconds: float) -> str:
        """What is said in the first `seconds` of a clip, for a voice model that is shown the clip with its words."""
        key = (path, path.stat().st_mtime, seconds)
        if key not in self._transcripts:
            from scipy.signal import resample_poly

            audio, rate = await asyncio.to_thread(sf.read, str(path), dtype="float32", always_2d=True)
            mono = audio.mean(axis=1)[: round(seconds * rate)]
            heard = await asyncio.to_thread(resample_poly, mono, HEARING_RATE, rate)
            self._transcripts[key] = await self._whisper.transcribe(heard.astype(np.float32))
        return self._transcripts[key]


@dataclass
class Said:
    """A piece of a reply as it was sent to be played."""

    text: str
    start: float  # when its audio starts playing, on the clock of time.perf_counter()
    seconds: float


@dataclass(frozen=True)
class Turn:
    """When the person's turn ended, for the report of how long the reply took."""

    stopped: float  # their last word
    understood: float  # their words in hand


class CascadeSession:
    """One conversation.

    `feed()` follows the person's audio and acts on what the listener reports;
    each turn of theirs starts `_respond()`, which streams the language
    model's reply through the voice model and sends it a little ahead of its
    playing. `_said` is what has been sent of the current reply and when each
    piece plays, which is how a cut-in knows what the person heard.
    """

    def __init__(self, whisper: Whisper, synth: Synth, llm: Llm, http: aiohttp.ClientSession,
                 settings: dict[str, Any], voice: Path | None, voice_text: str, release: Callable[[], None]):
        self._whisper, self._synth, self._llm, self._http = whisper, synth, llm, http
        self._voice, self._voice_text = voice, voice_text
        self._release = release
        self._temperature = settings["temperature"]
        self._liveliness = settings["liveliness"]
        self._interruptible = settings["interruptible"]
        self._tags = synth.tags if settings["sounds"] else ()
        self._free_tags = synth.free_tags and settings["sounds"]
        parts = [settings["character"].strip(), SPOKEN]
        if settings["fillers"]:
            parts.append(FILLERS)
        if settings["sounds"]:
            parts.append(_sounds(synth))
        self._system = "\n\n".join(part for part in parts if part)
        self._history: list[dict] = []  # the conversation as the language model is shown it
        self._listener = Listener(settings["pause"])
        self._events: asyncio.Queue[Event | Exception | None] = asyncio.Queue()
        self._reply: asyncio.Task | None = None
        self._early: asyncio.Task | None = None  # a transcription started at a pause
        self._turns: set[asyncio.Task] = set()
        self._said: list[Said] = []
        self._message: dict | None = None  # the reply in `_history` that `_said` makes up
        self._plays_until = 0.0  # when the audio sent so far will have played
        self._closed = False
        if settings["speak_first"]:
            self._history.append({"role": "user", "content": OPENING})
            self._reply = asyncio.ensure_future(self._respond(None))

    def feed(self, pcm: np.ndarray) -> None:
        if self._closed or not len(pcm):
            return
        if not self._interruptible and self._talking():
            self._listener.reset()
            return
        for signal in self._listener.hear(pcm):
            match signal:
                case Sustained():
                    self._stop_reply()
                case Paused(audio):
                    self._early = asyncio.ensure_future(self._whisper.transcribe(audio))
                case Resumed():
                    self._drop_early()
                case Ended(audio, sustained, quiet):
                    early, self._early = self._early, None
                    if not sustained and self._talking():
                        continue  # an "mm-hm" while it talks is not a turn
                    turn = asyncio.ensure_future(self._turn(audio, early, time.perf_counter() - quiet))
                    self._turns.add(turn)
                    turn.add_done_callback(self._turns.discard)

    def say(self, text: str) -> None:
        """A line the person typed, taken as their turn."""
        if not self._closed:
            self._take(text, None)

    async def events(self) -> AsyncIterator[Event]:
        while True:
            event = await self._events.get()
            if event is None:
                return
            if isinstance(event, ServiceError):
                raise event
            if isinstance(event, Exception):
                raise ServiceError(f"Cascade stopped: {event}") from event
            yield event

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._drop_early()
        for task in (self._reply, *self._turns):
            if task:
                task.cancel()
        self._synth.cancel()
        await self._http.close()
        self._release()

    def _talking(self) -> bool:
        """Whether a reply is on its way or still being heard."""
        return (self._reply is not None and not self._reply.done()) or time.perf_counter() < self._plays_until

    def _drop_early(self) -> None:
        if self._early:
            self._early.cancel()
            self._early = None

    async def _turn(self, audio: np.ndarray, early: asyncio.Task | None, stopped: float) -> None:
        try:
            text = await (early or self._whisper.transcribe(audio))
        except Exception as error:
            logger.exception("cascade could not hear")
            self._events.put_nowait(error)
            return
        if text and not self._closed:
            self._events.put_nowait(Heard(text))
            self._take(text, Turn(stopped, time.perf_counter()))

    def _take(self, text: str, turn: Turn | None) -> None:
        """The person's turn: whatever it was saying stops, and it answers this."""
        self._stop_reply()
        if self._history and self._history[-1]["role"] == "user":
            self._history[-1]["content"] += " " + text  # they went on before it answered
        else:
            self._history.append({"role": "user", "content": text})
        self._reply = asyncio.ensure_future(self._respond(turn))

    def _stop_reply(self) -> None:
        """Stop the reply under way, and keep in the history only what the person heard of it."""
        if self._reply and not self._reply.done():
            self._reply.cancel()
            self._synth.cancel()
        self._reply = None
        now = time.perf_counter()
        if now >= self._plays_until:
            return  # everything sent has been heard
        self._events.put_nowait(Interrupt())
        self._plays_until = now
        heard = []
        for said in self._said:
            if said.start >= now:
                break
            if said.start + said.seconds <= now:
                heard.append(said.text)
            else:
                words = said.text.split()
                heard.append(" ".join(words[: int(len(words) * (now - said.start) / said.seconds)]) + "—")
        content = " ".join(heard).strip()
        logger.info("the person cut in after hearing: %s", content or "nothing")
        if self._message is not None:
            if content.strip("—"):
                self._message["content"] = content
            else:
                self._history.remove(self._message)
        self._said, self._message = [], None

    async def _respond(self, turn: Turn | None) -> None:
        self._said, self._message = [], None
        pieces: asyncio.Queue[tuple[str, asyncio.Future] | None] = asyncio.Queue()
        asked = time.perf_counter()
        written = 0.0  # when the first piece was written

        def voice(piece: str) -> None:
            nonlocal written
            written = written or time.perf_counter()
            if text := speakable(piece, self._tags, self._free_tags):
                speech = asyncio.ensure_future(
                    self._synth.speak(text, self._voice, self._liveliness, self._voice_text))
                pieces.put_nowait((piece, speech))

        async def think() -> None:
            chunker = Chunker()
            try:
                messages = [{"role": "system", "content": self._system}, *self._history]
                async for text in self._llm.chat(messages, self._temperature):
                    for piece in chunker.push(text):
                        voice(piece)
                for piece in chunker.flush():
                    voice(piece)
            finally:
                pieces.put_nowait(None)

        thinking = asyncio.ensure_future(think())
        try:
            while (item := await pieces.get()) is not None:
                piece, speech = item
                pcm = await speech
                if not len(pcm):
                    continue
                if (wait := self._plays_until - LEAD - time.perf_counter()) > 0:
                    await asyncio.sleep(wait)
                now = time.perf_counter()
                if not self._said and turn:
                    self._events.put_nowait(Report(
                        f"Answered {now - turn.stopped:.1f} s after you stopped: {turn.understood - turn.stopped:.1f} s "
                        f"to hear you out, {written - asked:.1f} s to think, {now - written:.1f} s to voice it"))
                start = max(now, self._plays_until)
                self._said.append(Said(piece, start, len(pcm) / SAMPLE_RATE))
                self._plays_until = start + self._said[-1].seconds
                if self._message is None:
                    self._message = {"role": "assistant", "content": ""}
                    self._history.append(self._message)
                self._message["content"] = " ".join(said.text for said in self._said)
                self._events.put_nowait(Text(piece + " "))
                self._events.put_nowait(Audio(pcm))
            await thinking
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.exception("cascade could not reply")
            self._events.put_nowait(error)
        finally:
            thinking.cancel()
