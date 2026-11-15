"""The voice services model-harness offers. A new one is an adapter module and a line here."""

from __future__ import annotations

from ..voices import VoiceStore
from .base import Service
from .cascade import Cascade
from .haru import Haru


def registry(voices: VoiceStore) -> dict[str, Service]:
    services: list[Service] = [Cascade(voices), Haru(voices)]
    return {service.id: service for service in services}
