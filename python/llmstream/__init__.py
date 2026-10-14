from __future__ import annotations

from .buffer import (
    SentenceBuffer,
    sanitize_for_tts,
    withhold_len,
)
from .decoders import JsonLinesDecoder, SSEDecoder, WireRecord
from .errors import (
    LLMStreamError,
    ProtocolError,
    ProviderError,
    ToolArgumentsError,
    UnsupportedProviderError,
)
from .pipeline import (
    Pipeline,
    iter_events,
    iter_sentences,
    parse_events,
    parse_stream,
    stream_parser,
)
from .providers import (
    PROVIDERS,
    AnthropicAdapter,
    GeminiAdapter,
    GenericAdapter,
    GroqAdapter,
    OpenAIAdapter,
    ProviderAdapter,
    create_adapter,
    detect_provider,
)
from .tool_parser import StreamingToolParser, ToolSlot, partial_json
from .types import (
    BufferOptions,
    StreamEvent,
    ToolCall,
)

__version__ = "0.1.0"

__all__ = [
    # one-call pipeline
    "parse_stream",
    "iter_sentences",
    "parse_events",
    "iter_events",
    "stream_parser",
    "Pipeline",
    # types
    "StreamEvent",
    "BufferOptions",
    "ToolCall",
    # buffer
    "SentenceBuffer",
    "sanitize_for_tts",
    "withhold_len",
    # tools
    "StreamingToolParser",
    "ToolSlot",
    "partial_json",
    # providers
    "ProviderAdapter",
    "OpenAIAdapter",
    "AnthropicAdapter",
    "GeminiAdapter",
    "GroqAdapter",
    "GenericAdapter",
    "detect_provider",
    "create_adapter",
    "PROVIDERS",
    # decoders
    "SSEDecoder",
    "JsonLinesDecoder",
    "WireRecord",
    # errors
    "LLMStreamError",
    "ProtocolError",
    "ProviderError",
    "ToolArgumentsError",
    "UnsupportedProviderError",
    "__version__",
]