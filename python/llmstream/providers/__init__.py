from __future__ import annotations

from typing import Any, Dict, Optional

from ..errors import UnsupportedProviderError
from ..types import StreamEvent
from .anthropic import AnthropicAdapter
from .base import ProviderAdapter
from .gemini import GeminiAdapter
from .generic import GenericAdapter
from .openai import GroqAdapter, OpenAIAdapter

__all__ = [
    "ProviderAdapter",
    "OpenAIAdapter",
    "AnthropicAdapter",
    "GeminiAdapter",
    "GroqAdapter",
    "GenericAdapter",
    "detect_provider",
    "create_adapter",
    "PROVIDERS",
]

PROVIDERS = {
    "openai": OpenAIAdapter,
    "anthropic": AnthropicAdapter,
    "gemini": GeminiAdapter,
    "groq": GroqAdapter,
    "generic": GenericAdapter,
}

_ANTHROPIC_TYPES = {
    "message_start", "message_delta", "message_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "ping",
}


def detect_provider(payload: Any) -> str:
    """Normative detection order"""
    if not isinstance(payload, dict):
        return "generic"
    if "candidates" in payload and isinstance(payload["candidates"], list):
        return "gemini"
    t = payload.get("type")
    if t in _ANTHROPIC_TYPES:
        return "anthropic"
    if t == "error" and "error" in payload:
        return "anthropic"
    if "x_groq" in payload:
        return "groq"
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        c0 = choices[0] if isinstance(choices[0], dict) else {}
        if "delta" in c0 or payload.get("object") == "chat.completion.chunk":
            return "openai"
    return "generic"


def create_adapter(
    provider: str = "auto",
    *,
    text_path: Optional[str] = None,
    tool_path: Optional[str] = None,
) -> ProviderAdapter:
    """Instantiate an adapter by explicit name (or a generic for "auto" pre-detect)"""
    if provider == "auto":
        return GenericAdapter(text_path=text_path, tool_path=tool_path)
    try:
        cls = PROVIDERS[provider]
    except KeyError:
        raise UnsupportedProviderError(f"unknown provider: {provider!r}") from None
    if provider == "generic":
        return cls(text_path=text_path, tool_path=tool_path)
    return cls()


def map_payload_with(adapter: ProviderAdapter, payload: Dict[str, Any]) -> list[StreamEvent]:
    return adapter.map_payload(payload)
