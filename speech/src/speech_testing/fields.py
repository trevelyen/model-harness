"""The settings a service offers.

A service declares its settings as fields. The page draws one control per
field from `describe()`, and what the page sends back passes through `read()`,
so a service only ever sees values of the type and range it declared.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .voices import ID as VOICE_ID

MAX_TEXT = 20_000


@dataclass(frozen=True)
class TextField:
    key: str
    label: str
    default: str = ""
    help: str = ""
    multiline: bool = False

    def describe(self) -> dict:
        return {"type": "text", "multiline": self.multiline}

    def coerce(self, value: Any) -> str:
        if not isinstance(value, str) or len(value) > MAX_TEXT:
            raise ValueError(f"{self.label} must be text of at most {MAX_TEXT} characters.")
        return value


@dataclass(frozen=True)
class NumberField:
    key: str
    label: str
    default: float
    minimum: float
    maximum: float
    step: float
    help: str = ""

    def describe(self) -> dict:
        return {"type": "number", "min": self.minimum, "max": self.maximum, "step": self.step}

    def coerce(self, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not self.minimum <= value <= self.maximum:
            raise ValueError(f"{self.label} must be a number from {self.minimum:g} to {self.maximum:g}.")
        return float(value)


@dataclass(frozen=True)
class ToggleField:
    key: str
    label: str
    default: bool = False
    help: str = ""

    def describe(self) -> dict:
        return {"type": "toggle"}

    def coerce(self, value: Any) -> bool:
        if not isinstance(value, bool):
            raise ValueError(f"{self.label} must be on or off.")
        return value


@dataclass(frozen=True)
class ChoiceField:
    key: str
    label: str
    default: str
    options: tuple[tuple[str, str], ...]  # (value, label)
    help: str = ""

    def describe(self) -> dict:
        return {"type": "choice", "options": [{"value": v, "label": l} for v, l in self.options]}

    def coerce(self, value: Any) -> str:
        if value not in {v for v, _ in self.options}:
            raise ValueError(f"{self.label} must be one of its options.")
        return value


@dataclass(frozen=True)
class VoiceField:
    """A voice from the library, by id; the empty string is no voice."""

    key: str
    label: str
    help: str = ""
    default: str = ""

    def describe(self) -> dict:
        return {"type": "voice"}

    def coerce(self, value: Any) -> str:
        if value == "":
            return ""
        if not isinstance(value, str) or not VOICE_ID.fullmatch(value):
            raise ValueError(f"{self.label} must be a voice from the library.")
        return value


Field = TextField | NumberField | ToggleField | ChoiceField | VoiceField


def describe(field: Field) -> dict:
    return {"key": field.key, "label": field.label, "help": field.help, "default": field.default, **field.describe()}


def read(fields: list[Field], raw: Any) -> dict[str, Any]:
    """The settings of one session: each field's value from `raw`, else its default."""
    if not isinstance(raw, dict):
        raise ValueError("Settings must be an object.")
    return {field.key: field.coerce(raw.get(field.key, field.default)) for field in fields}
