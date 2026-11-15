"""The language model: any server that speaks OpenAI's chat completions.

`Llm` streams a reply as it is written. `Chunker` cuts that stream into pieces
to be spoken one at a time, and `speakable()` turns a piece into what the
voice model takes.
"""

from __future__ import annotations

import json
import re
from typing import AsyncIterator

import aiohttp

from ..base import ServiceError

MAX_TOKENS = 500
TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=60)


class Llm:
    def __init__(self, http: aiohttp.ClientSession, url: str, key: str, model: str = "", thinks: bool = False):
        self._http = http
        self.url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {key}"} if key else {}
        self.model = model
        # A model that reasons before it answers keeps the person waiting, so it is asked not to.
        # Not every server knows the parameter; one that refuses it is asked again without.
        # llama-server switches Qwen's and Gemma's thinking through the chat template instead.
        self._extra = {} if thinks else {"reasoning_effort": "none", "chat_template_kwargs": {"enable_thinking": False}}

    async def models(self) -> list[str]:
        """The models the server offers. Raises when nothing answers at the URL."""
        try:
            async with self._http.get(f"{self.url}/models", headers=self._headers, timeout=TIMEOUT) as response:
                if response.status in (401, 403):
                    raise ServiceError(f"The language model at {self.url} refused its key.")
                if response.status != 200:
                    return []  # a server without a model list may still chat
                listed = (await response.json(content_type=None)).get("data") or []
                return [model["id"] for model in listed if isinstance(model, dict) and "id" in model]
        except (aiohttp.ClientError, TimeoutError, ValueError) as error:
            raise ServiceError(
                f"No language model answered at {self.url}. Start one there, such as "
                "`llama-server -m model.gguf --port 8080`, or point the setting at another."
            ) from error

    async def chat(self, messages: list[dict], temperature: float) -> AsyncIterator[str]:
        """The reply to `messages`, in pieces as the model writes it."""
        body = {"model": self.model, "messages": messages, "temperature": temperature,
                "max_tokens": MAX_TOKENS, "stream": True}
        try:
            async with self._http.post(f"{self.url}/chat/completions", json=body | self._extra,
                                       headers=self._headers, timeout=TIMEOUT) as response:
                if response.status == 400 and self._extra:
                    self._extra = {}
                    async for text in self.chat(messages, temperature):
                        yield text
                    return
                if response.status != 200:
                    raise ServiceError(f"The language model refused the request ({response.status}): "
                                       f"{_reason(await response.text())}")
                async for raw in response.content:
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        return
                    choices = json.loads(data).get("choices") or [{}]
                    text = (choices[0].get("delta") or {}).get("content")
                    if text:
                        yield text
        except (aiohttp.ClientError, TimeoutError, ValueError) as error:
            raise ServiceError(f"The language model at {self.url} stopped answering: {error}") from error


def _reason(body: str) -> str:
    try:
        error = json.loads(body).get("error")
        return error.get("message", str(error)) if isinstance(error, dict) else str(error or body)
    except (ValueError, AttributeError):
        return body[:300]


SENTENCE = re.compile(r"[.!?…]+[\"')\]]*\s+|\n+")
CLAUSE = re.compile(r"[,;:—–]\s+")
FIRST_WORDS = 2  # words from which a reply's first piece may end at a comma, to be heard sooner
LONGEST = 280  # characters a piece may run to before it is cut at a space


class Chunker:
    """Cuts a reply into pieces as it streams: whole sentences, and a shorter first piece."""

    def __init__(self):
        self._text = ""
        self._first = True

    def push(self, text: str) -> list[str]:
        self._text += text
        pieces = []
        while (end := self._cut()) is not None:
            piece, self._text = self._text[:end].strip(), self._text[end:]
            if piece:
                pieces.append(piece)
                self._first = False
        return pieces

    def flush(self) -> list[str]:
        piece, self._text = self._text.strip(), ""
        return [piece] if piece else []

    def _cut(self) -> int | None:
        text = self._text
        if "[" in text and "]" not in text[text.rindex("["):]:
            text = text[: text.rindex("[")]  # a tag still being written
        sentence = SENTENCE.search(text)
        while sentence and sentence.group().startswith(("..", "…")):
            # A trailing-off is the end of a sentence only when a new one follows it.
            if sentence.end() == len(text):
                return None  # what follows has not been written yet
            if not text[sentence.end()].islower():
                break
            sentence = SENTENCE.search(text, sentence.end())
        if self._first:
            # The wait for a reply's first piece is the wait the person feels, so it may end at a comma.
            for clause in CLAUSE.finditer(text, 0, sentence.start() if sentence else len(text)):
                if len(text[: clause.start()].split()) >= FIRST_WORDS:
                    return clause.end()
        if sentence:
            return sentence.end()
        if len(text) > LONGEST:
            return text.rindex(" ", 0, LONGEST) + 1 if " " in text[:LONGEST] else LONGEST
        return None


# How models write the sounds when they do not use the tag itself.
ALIASES = {
    "laughs": "laugh", "laughing": "laugh", "laughter": "laugh", "giggles": "chuckle", "giggle": "chuckle",
    "chuckles": "chuckle", "chuckling": "chuckle", "sighs": "sigh", "sighing": "sigh", "gasps": "gasp",
    "coughs": "cough", "clears throat": "clear throat", "sniffs": "sniff", "sniffles": "sniff",
    "sniffle": "sniff", "groans": "groan", "cries": "crying", "cry": "crying", "sobs": "crying",
    "sob": "crying", "sobbing": "crying", "whispers": "whispering", "whisper": "whispering",
}
BRACKETED = re.compile(r"\[([^\[\]]{1,30})\]")
ACTION = re.compile(r"[*(]([a-z ]{3,20})[*)]", re.IGNORECASE)
MARKUP = re.compile(r"[*_#`~|<>]+")
PICTURES = re.compile("[\U0001f000-\U0001faff☀-➿️‍]+")


def speakable(piece: str, tags: tuple[str, ...], free: bool = False) -> str:
    """`piece` as the voice model takes it: its tags kept, markup and anything unsayable removed.

    `tags` are the ones the model knows; with `free` it takes any, so all are kept. With no
    tags and not `free`, every tag is removed. Empty when there is nothing in the piece to say.
    """

    def tag(match: re.Match) -> str:
        name = match.group(1).strip().lower()
        if free:
            return f"[{name}]" if match.group(0)[0] == "[" or name in ALIASES else match.group(0)
        name = ALIASES.get(name, name)
        if name not in tags:  # "[dry chuckle]", "[laughs softly]": the sound in it, if there is one
            words = [ALIASES.get(word, word) for word in name.split()]
            name = next((word for word in words if word in tags), name)
        return f"[{name}]" if name in tags else ("" if match.group(0)[0] == "[" else match.group(0))

    text = ACTION.sub(tag, BRACKETED.sub(tag, piece))
    kept = BRACKETED.findall(text)
    text = MARKUP.sub("", PICTURES.sub("", BRACKETED.sub("\x00", text)))
    for name in kept:
        text = text.replace("\x00", f"[{name}]", 1)
    text = " ".join(text.split())
    return text if re.search(r"[A-Za-z0-9]", text) else ""
