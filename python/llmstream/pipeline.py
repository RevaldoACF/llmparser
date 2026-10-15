"""
Accepts any iterable/async-iterable of chunks where a chunk is:
  - bytes or str
  - dict (pre-parsed payload)
"""
from __future__ import annotations

import asyncio
import inspect
import json
from functools import wraps
from typing import Any, AsyncIterator, Iterator, List, Optional, Tuple, Union

from .buffer import SentenceBuffer
from .decoders import JsonLinesDecoder, SSEDecoder
from .errors import LLMStreamError, ProtocolError, ProviderError, ToolArgumentsError
from .providers import PROVIDERS, create_adapter, detect_provider
from .providers.base import ProviderAdapter
from .tool_parser import StreamingToolParser
from .types import BufferOptions, StreamEvent, resolve_buffer

__all__ = [
    "parse_stream",
    "iter_sentences",
    "parse_events",
    "iter_events",
    "stream_parser",
    "Pipeline",
]


def _is_async_iter(obj: Any) -> bool:
    return hasattr(obj, "__aiter__") and not hasattr(obj, "__iter__")


def _raise_if_error(ev: StreamEvent, on_error: str) -> None:
    if ev.type != "error" or on_error != "raise":
        return
    if ev.code == "tool_arguments_invalid":
        raise ToolArgumentsError("", ev.raw_arguments, ev.message)
    if ev.code == "malformed_chunk":
        raw = ev.raw.get("raw", "") if isinstance(ev.raw, dict) else ""
        raise ProtocolError(ev.message, raw=raw)
    raise ProviderError(ev.code, ev.message, ev.provider_error)


# ParserCore — single source of truth used by sync & async pipelines

class ParserCore:
    """feed chunks (bytes/str/dict), get normalized events.

    Owns: wire decoder(s), provider adapter (auto-detected or explicit),
    StreamingToolParser, and the SSE→JSONL auto fallback
    """

    def __init__(
        self,
        provider: str = "auto",
        stream_format: str = "auto",
        on_error: str = "raise",
        text_path: Optional[str] = None,
        tool_path: Optional[str] = None,
    ) -> None:
        if on_error not in ("raise", "skip"):
            raise ValueError("on_error must be 'raise' or 'skip'")
        self.on_error = on_error
        self.tool_parser = StreamingToolParser()
        self._adapter: Optional[ProviderAdapter] = (
            None if provider == "auto"
            else create_adapter(provider, text_path=text_path, tool_path=tool_path)
        )
        self._sse: Optional[SSEDecoder] = None
        self._jsonl: Optional[JsonLinesDecoder] = None
        if stream_format == "jsonl":
            self._jsonl = JsonLinesDecoder()
        elif stream_format != "sse":
            self._sse = SSEDecoder()
        self._pre_parsed: Optional[bool] = None
        self._raw_history: List[Any] = [] if stream_format == "auto" else []
        self._sse_produced = False
        self._closed = False

    # -- internals

    def _payload_events(self, payload: dict) -> Iterator[StreamEvent]:
        """Map one pre-parsed payload through the adapter + tool parser."""
        if self._adapter is None:  # lock on first parseable payload
            self._adapter = create_adapter(detect_provider(payload))
        for ev in self._adapter.map_payload(payload):
            if ev.type == "tool_call_delta":
                self.tool_parser.on_tool_call_delta(ev)
            yield ev
        scope = self._adapter.take_finalize()
        if scope == "all":
            yield from self.tool_parser.finalize()
        elif scope:
            yield from self.tool_parser.finalize(indices=scope)

    def _line_events(self, line: str) -> Iterator[StreamEvent]:
        if line.strip() == "[DONE]":
            return
        try:
            payload = json.loads(line)
        except (json.JSONDecodeError, ValueError) as e:
            ev = StreamEvent(
                type="error", code="malformed_chunk",
                message=str(e), raw={"raw": line},
            )
            _raise_if_error(ev, self.on_error)
            yield ev
            return
        if not isinstance(payload, dict):
            return
        if self._adapter is None:  # lock on first parseable payload
            self._adapter = create_adapter(detect_provider(payload))
        for ev in self._adapter.map_payload(payload):
            if ev.type == "tool_call_delta":
                self.tool_parser.on_tool_call_delta(ev)
            yield ev
        scope = self._adapter.take_finalize()
        if scope == "all":
            yield from self.tool_parser.finalize()
        elif scope:
            yield from self.tool_parser.finalize(indices=scope)

    def _drain(self, lines: Iterator[str]) -> Iterator[StreamEvent]:
        for line in lines:
            self._sse_produced = True
            yield from self._line_events(line)

    # -- public feed

    def feed(self, chunk: Any) -> Iterator[StreamEvent]:
        """Feed one chunk; yield zero or more events."""
        if isinstance(chunk, dict):
            if self._pre_parsed is False and self._sse is not None:
                raise LLMStreamError("mixing raw and pre-parsed chunks")
            self._pre_parsed = True
            yield from self._payload_events(chunk)
            return
        # raw chunk
        if self._pre_parsed is True:
            raise LLMStreamError("mixing raw and pre-parsed chunks")
        self._pre_parsed = False
        if self._jsonl is not None:
            yield from self._drain(self._jsonl.feed(chunk))
            return
        if self._sse is not None:
            if not self._sse_produced:
                self._raw_history.append(chunk)  # auto-fallback retention
            for rec in self._sse.feed(chunk):
                yield from self._drain(iter([rec.data]))
            return
        # pre-parsed only mode should not reach here
        raise LLMStreamError("no decoder available")

    def close(self) -> Iterator[StreamEvent]:
        if self._closed:
            return
        self._closed = True
        if self._jsonl is not None:
            tail = self._jsonl.close()
            if tail:
                yield from self._drain(iter([tail]))
        elif self._sse is not None:
            tail = self._sse.close()
            if tail:
                yield from self._drain(iter([tail.data]))
        # SSE→JSONL auto fallback
        if (
            self._sse is not None
            and not self._sse_produced
            and self._raw_history
        ):
            self._sse = None
            jsonl = JsonLinesDecoder()
            for chunk in self._raw_history:
                yield from self._drain(jsonl.feed(chunk))
            tail = jsonl.close()
            if tail:
                yield from self._drain(iter([tail]))
        self._raw_history.clear()
        yield from self.tool_parser.finalize()
        if self._adapter is not None:
            yield from self._adapter.finalize()
        yield StreamEvent(type="done")


def _dump(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":"))


# Event iterators

def iter_events(
    chunks: Any,
    *,
    provider: str = "auto",
    stream_format: str = "auto",
    on_error: str = "raise",
    text_path: Optional[str] = None,
    tool_path: Optional[str] = None,
) -> Iterator[StreamEvent]:
    core = ParserCore(provider, stream_format, on_error, text_path, tool_path)
    for chunk in chunks:
        for ev in core.feed(chunk):
            yield ev
    for ev in core.close():
        yield ev


# Buffering

def _buffer_sync(events: Iterator[StreamEvent], opts: Optional[BufferOptions]) -> Iterator[str]:
    buf = SentenceBuffer(opts) if opts is not None else None
    for ev in events:
        if ev.type == "delta":
            if buf is None:
                yield ev.text
            else:
                yield from buf.feed(ev.text)
    if buf is not None:
        yield from buf.close()


# Public API

def iter_sentences(
    chunks: Any,
    *,
    provider: str = "auto",
    buffer: Union[BufferOptions, str, bool] = "voice",
    stream_format: str = "auto",
    on_error: str = "raise",
) -> Iterator[str]:
    opts = resolve_buffer(buffer)
    events = iter_events(chunks, provider=provider, stream_format=stream_format, on_error=on_error)
    yield from _buffer_sync(events, opts)


# Public API

async def parse_events(
    chunks: Any,
    *,
    provider: str = "auto",
    stream_format: str = "auto",
    on_error: str = "raise",
    text_path: Optional[str] = None,
    tool_path: Optional[str] = None,
) -> AsyncIterator[StreamEvent]:
    if _is_async_iter(chunks):
        core = ParserCore(provider, stream_format, on_error, text_path, tool_path)
        aiter = chunks.__aiter__()
        while True:
            try:
                chunk = await aiter.__anext__()
            except StopAsyncIteration:
                break
            for ev in core.feed(chunk):
                yield ev
        for ev in core.close():
            yield ev
    else:
        for ev in iter_events(
            chunks, provider=provider, stream_format=stream_format,
            on_error=on_error, text_path=text_path, tool_path=tool_path,
        ):
            yield ev


def iter_tokens(
    chunks: Any,
    *,
    provider: str = "auto",
    stream_format: str = "auto",
    on_error: str = "raise",
    text_path: Optional[str] = None,
    tool_path: Optional[str] = None,
) -> Iterator[str]:
    """Yields raw delta text as it arrives, no buffering."""
    core = ParserCore(provider, stream_format, on_error, text_path, tool_path)
    for chunk in chunks:
        for ev in core.feed(chunk):
            if ev.type == "delta":
                yield ev.text
    for ev in core.close():
        if ev.type == "delta":
            yield ev.text


async def _parse_tokens_async(
    chunks: Any,
    provider: str,
    stream_format: str,
    on_error: str,
    text_path: Optional[str],
    tool_path: Optional[str],
):
    core = ParserCore(provider, stream_format, on_error, text_path, tool_path)
    aiter = chunks.__aiter__()
    while True:
        try:
            chunk = await aiter.__anext__()
        except StopAsyncIteration:
            break
        for ev in core.feed(chunk):
            if ev.type == "delta":
                yield ev.text
    for ev in core.close():
        if ev.type == "delta":
            yield ev.text


def parse_tokens(
    chunks: Any,
    *,
    provider: str = "auto",
    stream_format: str = "auto",
    on_error: str = "raise",
    text_path: Optional[str] = None,
    tool_path: Optional[str] = None,
):
    """Raw token stream, no sentence buffering. Async input gives an async iterator."""
    if _is_async_iter(chunks):
        return _parse_tokens_async(
            chunks, provider, stream_format, on_error, text_path, tool_path
        )
    return iter_tokens(
        chunks, provider=provider, stream_format=stream_format,
        on_error=on_error, text_path=text_path, tool_path=tool_path,
    )


def parse_stream(
    chunks: Any,
    *,
    provider: str = "auto",
    buffer: Union[BufferOptions, str, bool] = "voice",
    stream_format: str = "auto",
    on_error: str = "raise",
    text_path: Optional[str] = None,
    tool_path: Optional[str] = None,
):
    """THE one-call entry point.

    - async iterable chunks  -> async sentence iterator (idle_timeout honored)
    - sync iterable chunks   -> sync sentence iterator
    """
    if _is_async_iter(chunks):
        return _parse_stream_async(
            chunks, provider=provider, buffer=buffer,
            stream_format=stream_format, on_error=on_error,
            text_path=text_path, tool_path=tool_path,
        )
    return iter_sentences(
        chunks, provider=provider, buffer=buffer,
        stream_format=stream_format, on_error=on_error,
    )


async def _parse_stream_async(
    chunks: AsyncIterator,
    *,
    provider: str,
    buffer,
    stream_format: str,
    on_error: str,
    text_path: Optional[str],
    tool_path: Optional[str],
) -> AsyncIterator[str]:
    opts = resolve_buffer(buffer)
    buf = SentenceBuffer(opts) if opts is not None else None
    core = ParserCore(provider, stream_format, on_error, text_path, tool_path)
    aiter = chunks.__aiter__()
    anext_task: Optional["asyncio.Future"] = None
    try:
        while True:
            if anext_task is None:
                anext_task = asyncio.ensure_future(aiter.__anext__())
            armed = bool(
                opts
                and opts.idle_timeout > 0
                and buf is not None
                and buf.pending
            )
            done, _ = await asyncio.wait(
                {anext_task}, timeout=opts.idle_timeout if armed else None
            )
            if not done:
                if buf is not None:
                    for s in buf.force_flush():
                        yield s
                continue
            task, anext_task = anext_task, None
            try:
                chunk = task.result()
            except StopAsyncIteration:
                break
            for ev in core.feed(chunk):
                if ev.type == "delta":
                    if buf is None:
                        yield ev.text
                    else:
                        for s in buf.feed(ev.text):
                            yield s
    finally:
        if anext_task is not None and not anext_task.done():
            anext_task.cancel()
            try:
                await anext_task
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
    for ev in core.close():
        if ev.type == "delta":
            if buf is None:
                yield ev.text
            else:
                for s in buf.feed(ev.text):
                    yield s
    if buf is not None:
        for s in buf.close():
            yield s


# @stream_parser decorator

def stream_parser(
    buffer: Union[BufferOptions, str, bool] = "voice",
    *,
    provider: str = "auto",
    stream_format: str = "auto",
    on_error: str = "raise",
):
    """Wrap a (async) generator that yields raw chunks so it yields
    clean sentences instead.

        @stream_parser(buffer="voice")
        async def chat(prompt):
            async for chunk in httpx_client.stream(...):
                yield chunk

        async for sentence in chat("hi"):
            tts.speak(sentence)
    """

    def deco(fn):
        if inspect.isasyncgenfunction(fn):

            @wraps(fn)
            async def async_wrapper(*a, **kw):
                gen = fn(*a, **kw)
                async for s in parse_stream(
                    gen, provider=provider, buffer=buffer,
                    stream_format=stream_format, on_error=on_error,
                ):
                    yield s

            return async_wrapper
        if inspect.isgeneratorfunction(fn):

            @wraps(fn)
            def sync_wrapper(*a, **kw):
                gen = fn(*a, **kw)
                for s in parse_stream(
                    gen, provider=provider, buffer=buffer,
                    stream_format=stream_format, on_error=on_error,
                ):
                    yield s

            return sync_wrapper
        raise TypeError("@stream_parser requires a generator function")

    return deco


# Optional OOP surface

class Pipeline:
    """Object-style wrapper over the same core."""

    def __init__(
        self,
        *,
        provider: str = "auto",
        buffer: Union[BufferOptions, str, bool] = "voice",
        stream_format: str = "auto",
        on_error: str = "raise",
    ) -> None:
        self.provider = provider
        self.buffer = buffer
        self.stream_format = stream_format
        self.on_error = on_error

    def sentences(self, chunks: Any) -> Any:
        return parse_stream(
            chunks, provider=self.provider, buffer=self.buffer,
            stream_format=self.stream_format, on_error=self.on_error,
        )

    def events(self, chunks: Any) -> Any:
        if _is_async_iter(chunks):
            return parse_events(
                chunks, provider=self.provider, stream_format=self.stream_format,
                on_error=self.on_error,
            )
        return iter_events(
            chunks, provider=self.provider, stream_format=self.stream_format,
            on_error=self.on_error,
        )
