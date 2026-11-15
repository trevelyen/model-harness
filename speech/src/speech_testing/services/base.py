"""What a voice service is to the rest of the app.

The server and the page know services only through this module: a `Service`
describes itself and opens sessions, and a `Session` takes the person's audio
and yields events. Everything particular to one service stays in its adapter.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, AsyncIterator, Awaitable, Callable, Protocol, runtime_checkable

import numpy as np

from ..fields import Field


class Kind(str, Enum):
    """How a service is talked to. The page draws one surface per kind."""

    DUPLEX = "duplex"  # speech in and speech out, both at once


class ServiceError(Exception):
    """A failure the person should read as it is written."""


@dataclass(frozen=True)
class Status:
    ready: bool  # whether a session can be started now
    detail: str


@dataclass(frozen=True)
class Audio:
    pcm: np.ndarray  # mono float32 at the service's sample rate


@dataclass(frozen=True)
class Text:
    text: str  # what the service is saying, as it says it


@dataclass(frozen=True)
class Heard:
    text: str  # what the service took the person to have said


@dataclass(frozen=True)
class Report:
    text: str  # a line on how the session is running, for the status


@dataclass(frozen=True)
class Interrupt:
    """The person cut in: the service's audio sent but not yet played is to be dropped."""


@dataclass(frozen=True)
class Stats:
    step_ms: float  # compute time of a frame
    frame_ms: float  # audio a frame holds; a step longer than this falls behind


Event = Audio | Text | Heard | Interrupt | Stats | Report

Progress = Callable[[str], Awaitable[None]]


class Session(Protocol):
    def feed(self, pcm: np.ndarray) -> None:
        """Take the person's audio as it arrives: mono float32 at the service's sample rate, any length."""
        ...

    def events(self) -> AsyncIterator[Event]:
        """What the service produces, until the session ends."""
        ...

    async def close(self) -> None: ...


@runtime_checkable
class TakesText(Protocol):
    """A session that takes what the person types as text. Without this the typed line is spoken into its audio."""

    def say(self, text: str) -> None: ...


class Service(Protocol):
    id: str
    name: str
    kind: Kind
    summary: str
    sample_rate: int
    ahead: bool  # its audio arrives faster than it plays, so the page keeps all of it rather than staying live

    def fields(self) -> list[Field]: ...

    def status(self) -> Status: ...

    async def open(self, settings: dict[str, Any], progress: Progress) -> Session:
        """Start a session with settings already read through the service's fields.

        `progress` reports slow steps (a download, loading a model) in words.
        """
        ...
