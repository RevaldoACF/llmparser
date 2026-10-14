from __future__ import annotations


class LLMStreamError(Exception):
    """Base class for all llmstream errors."""


class ProtocolError(LLMStreamError):
    """Broken SSE framing or unparseable wire JSON (malformed chunk)."""

    def __init__(self, message: str, raw: str = "") -> None:
        super().__init__(message)
        self.raw = raw


class ProviderError(LLMStreamError):
    """The provider API returned an error payload."""

    def __init__(self, code: str, message: str, provider_error: object = None) -> None:
        super().__init__(message)
        self.code = code
        self.provider_error = provider_error


class UnsupportedProviderError(LLMStreamError):
    """An unknown provider name was requested."""


class ToolArgumentsError(LLMStreamError):
    """Accumulated tool-call arguments were not valid JSON at end signal."""

    def __init__(self, name: str, raw_arguments: str, brief: str = "") -> None:
        super().__init__(
            f"invalid tool arguments for '{name}': {brief}".strip()
        )
        self.name = name
        self.raw_arguments = raw_arguments
