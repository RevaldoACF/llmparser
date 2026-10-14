from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

__all__ = [
    "StreamEvent",
    "BufferOptions",
    "ToolCall",
    "PRESET_VOICE",
    "PRESET_UI",
    "PRESET_OFF",
    "resolve_buffer",
    "codepoint_len",
    "is_space",
    "is_digit",
    "is_alpha",
    "is_alnum",
]


# StreamEvent

@dataclass
class StreamEvent:
    type: str  # delta | reasoning_delta | tool_call_delta | tool_call_complete | usage | metadata | error | done
    # delta / reasoning_delta
    text: str = ""
    # tool_call_delta
    index: int = 0
    id: Optional[str] = None
    name: str = ""
    arguments_delta: str = ""
    # tool_call_complete
    arguments: Optional[Dict[str, Any]] = None
    raw_arguments: str = ""
    # usage
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    # metadata
    provider: str = ""
    model: Optional[str] = None
    finish_reason: Optional[str] = None
    raw: Optional[Dict[str, Any]] = None
    # error
    code: str = ""
    message: str = ""
    provider_error: Optional[Dict[str, Any]] = None

    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def to_dict(self) -> Dict[str, Any]:
        """Serialize only the fields relevant to this event type (for tests/debug)."""
        out: Dict[str, Any] = {"type": self.type}
        if self.type in ("delta", "reasoning_delta"):
            out["text"] = self.text
        elif self.type == "tool_call_delta":
            out["index"] = self.index
            if self.id is not None:
                out["id"] = self.id
            if self.name:
                out["name"] = self.name
            if self.arguments_delta:
                out["arguments_delta"] = self.arguments_delta
        elif self.type == "tool_call_complete":
            out.update(
                index=self.index,
                name=self.name,
                arguments=self.arguments,
                raw_arguments=self.raw_arguments,
            )
            if self.id is not None:
                out["id"] = self.id
        elif self.type == "usage":
            for k in ("input_tokens", "output_tokens", "total_tokens"):
                v = getattr(self, k)
                if v is not None:
                    out[k] = v
        elif self.type == "metadata":
            out["provider"] = self.provider
            if self.model is not None:
                out["model"] = self.model
            if self.finish_reason is not None:
                out["finish_reason"] = self.finish_reason
        elif self.type == "error":
            out["code"] = self.code
            out["message"] = self.message
        return out

    def __repr__(self) -> str:
        return f"StreamEvent({self.to_dict()!r})"


# BufferOptions

#: Values are normalized
#: (lowercase, interior dots kept, trailing dots removed).
DEFAULT_ABBREVIATIONS: frozenset = frozenset(
    {
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "no", "fig", "vs",
        "etc", "inc", "ltd", "co", "corp", "approx", "dept", "est", "min",
        "max", "vol", "pg", "pp", "e.g", "i.e", "cf", "al", "gen", "rep",
        "sen", "assn",
    }
)


@dataclass
class BufferOptions:
    """Sentence-buffer configuration. Defaults = "voice" minus idle_timeout"""

    min_chunk_size: int = 40
    max_buffer_size: int = 400
    idle_timeout: float = 0.0  # in seconds, async pipelines only (ignored in sync)
    strategy: str = "sentence"  # sentence | clause | fixed | regex:<pattern>
    # note: spaces inside these strings are separators, not boundary chars
    sentence_enders: str = ". ! ? … 。 ！"
    soft_boundary: str = ", ; : —"
    strip_markdown: bool = True
    strip_emoji: bool = True
    collapse_whitespace: bool = True
    guard_tags: List[str] = field(default_factory=lambda: ["```", "~~~", "`"])
    guard_tags_extra: List[str] = field(default_factory=list)
    code_block_mode: str = "passthrough"  # passthrough | drop | sanitize
    additional_abbrevs: List[str] = field(default_factory=list)
    on_error: str = "raise"  # raise | skip

    @property
    def all_guard_tags(self) -> List[str]:
        return list(self.guard_tags) + list(self.guard_tags_extra)

    @property
    def abbreviations(self) -> frozenset:
        extra = {_normalize_abbrev(a) for a in self.additional_abbrevs}
        return DEFAULT_ABBREVIATIONS | extra


def _normalize_abbrev(word: str) -> str:
    return word.strip().rstrip(".").lower()


PRESET_VOICE = BufferOptions(idle_timeout=0.5)
PRESET_UI = BufferOptions(
    strategy="clause",
    min_chunk_size=20,
    strip_markdown=False,
    strip_emoji=False,
    idle_timeout=0.0,
)
PRESET_OFF = "off"  # sentinel handled by resolve_buffer

_PRESETS = {"voice": PRESET_VOICE, "ui": PRESET_UI, "off": PRESET_OFF}


def resolve_buffer(
    buffer: Any,
) -> Optional[BufferOptions]:
    """Expand a preset name / BufferOptions / bool into BufferOptions (or None)

    Accepts: "voice" | "ui" | "off" | False | BufferOptions
    Returns None when the buffer is disabled ("off"/False)
    """
    if buffer in (None, False):
        return None
    if isinstance(buffer, str):
        if buffer not in _PRESETS:
            raise ValueError(f"unknown buffer preset: {buffer!r}")
        return None if buffer == "off" else _PRESETS[buffer]
    if isinstance(buffer, BufferOptions):
        return buffer
    raise TypeError(f"invalid buffer option: {type(buffer)!r}")


# Unicode helpers

def codepoint_len(s: str) -> int:
    """Code-point length (Python `len` is already codepoints)."""
    return len(s)


def is_space(c: str) -> bool:
    return c.isspace()


def is_digit(c: str) -> bool:
    return "0" <= c <= "9"


def is_alpha(c: str) -> bool:
    return c.isalpha()


def is_alnum(c: str) -> bool:
    return is_alpha(c) or is_digit(c)


# Tool call result

@dataclass
class ToolCall:
    """validated tool call"""

    index: int
    id: Optional[str]
    name: str
    arguments: Dict[str, Any]
    raw_arguments: str = ""
