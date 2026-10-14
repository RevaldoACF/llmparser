from __future__ import annotations

import asyncio

import pytest

from llmstream import (
    SentenceBuffer,
    partial_json,
    parse_events,
    parse_stream,
    stream_parser,
    iter_sentences,
)
from llmstream.errors import LLMStreamError
from llmstream.types import BufferOptions


# Boundary rules (edge case catalog E1, E3, E4, E17)

def test_decimal_not_boundary():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("3.14 is pi. Next?"))
    out += list(buf.close())
    assert out == ["3.14 is pi.", "Next?"]


def test_domain_not_boundary():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("See example.com for details. Bye."))
    out += list(buf.close())
    assert out == ["See example.com for details.", "Bye."]


def test_parenthesized_domain_boundary():
    # Rule U must NOT fire when next char is ')' (E17)
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("(a.com). Hello there."))
    out += list(buf.close())
    assert out == ["(a.com).", "Hello there."]


def test_ellipsis_single_boundary():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("Wait... what?"))
    out += list(buf.close())
    assert out == ["Wait... what?"]


def test_abbreviation():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("Dr. Smith went home. He slept."))
    out += list(buf.close())
    assert out == ["Dr. Smith went home.", "He slept."]


def test_closing_quote_swallowed():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("'Done.' he said. More words here."))
    out += list(buf.close())
    assert out[0] == "'Done.' he said."
    assert out[1] == "More words here."


# Tag guard

def test_partial_backtick_withheld_then_released():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=5))
    out = list(buf.feed("End of word. ``"))
    assert out == ["End of word."]
    out += list(buf.feed("not a fence. Next."))
    out += list(buf.close())
    assert "not a fence." in " ".join(out)


def test_custom_tag_held_until_complete():
    opts = BufferOptions(min_chunk_size=5, guard_tags_extra=["<tag>", "</tag>"])
    buf = SentenceBuffer(opts)
    out = list(buf.feed("First sentence here. <ta"))
    assert out == ["First sentence here."]
    out2 = list(buf.feed("g>body</tag> Second sentence!"))
    out2 += list(buf.close())
    joined = " ".join(out2)
    assert "<tag>body</tag>" in joined


# Idle timeout (async only)

def _slow_async(source):
    async def gen():
        for s in source:
            yield s
            await asyncio.sleep(0.05)
    return gen()


def test_idle_timeout_flushes():
    async def run():
        # stream pauses 0.3s (> 0.1 timeout) mid-sentence, then continues
        chunks = _slow_async(
            [
                "data: {\"choices\":[{\"delta\":{\"content\":\"A very long partial \"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"sentence here. End!\"}}]}\n\n",
                "data: [DONE]\n\n",
            ]
        )
        # Wrap with a manual delay between first and rest
        out = []
        return chunks

    async def run2():
        async def gen():
            yield "data: {\"choices\":[{\"delta\":{\"content\":\"A very long partial \"}}]}\n\n"
            await asyncio.sleep(0.3)
            yield "data: {\"choices\":[{\"delta\":{\"content\":\"sentence here. End!\"}}]}\n\n"
            yield "data: [DONE]\n\n"
        opts = BufferOptions(min_chunk_size=10, max_buffer_size=1000, idle_timeout=0.1)
        out = []
        async for s in parse_stream(gen(), buffer=opts, provider="openai"):
            out.append(s)
        return out

    out = asyncio.run(run2())
    assert out[0] == "A very long partial"  # idle-forced flush
    assert "sentence here." in " ".join(out)


def test_idle_timeout_ignored_in_sync():
    # silently ignore it (no boundary -> single close flush)
    out = list(
        iter_sentences(
            ["data: {\"choices\":[{\"delta\":{\"content\":\"A partial bit of text here.\"}}]}\n\n"],
            buffer=BufferOptions(min_chunk_size=5, idle_timeout=0.5),
        )
    )
    assert out == ["A partial bit of text here."]


# Test one API

def test_stream_parser_sync_decorator():
    @stream_parser(buffer=BufferOptions(min_chunk_size=5))
    def gen():
        yield "data: {\"choices\":[{\"delta\":{\"content\":\"Hello world. Bye!\"}}]}\n\n"
        yield "data: [DONE]\n\n"

    out = list(gen())
    assert out == ["Hello world.", "Bye!"]


def test_stream_parser_async_decorator():
    @stream_parser(buffer=BufferOptions(min_chunk_size=5))
    async def gen():
        yield "data: {\"choices\":[{\"delta\":{\"content\":\"Hello world. Bye!\"}}]}\n\n"
        yield "data: [DONE]\n\n"

    async def run():
        out = []
        async for s in gen():
            out.append(s)
        return out

    assert asyncio.run(run()) == ["Hello world.", "Bye!"]


def test_parse_stream_sync_convenience():
    out = list(
        parse_stream(
            [
                "data: {\"choices\":[{\"delta\":{\"content\":\"One two. Three!\"}}]}\n\n",
                "data: [DONE]\n\n",
            ],
            buffer=BufferOptions(min_chunk_size=5),
        )
    )
    assert out == ["One two.", "Three!"]


def test_pre_parsed_dict_input():
    chunks = [
        {"choices": [{"delta": {"content": "Hi there. Bye!"}}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
    ]
    out = list(
        parse_stream(chunks, buffer=BufferOptions(min_chunk_size=5), provider="openai")
    )
    assert out == ["Hi there.", "Bye!"]


def test_empty_stream():
    assert list(parse_stream([], buffer="voice")) == []


def test_buffer_off_preset_passes_deltas():
    out = list(
        parse_stream(
            [
                "data: {\"choices\":[{\"delta\":{\"content\":\"ab\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"cd\"}}]}\n\n",
                "data: [DONE]\n\n",
            ],
            buffer="off",
        )
    )
    assert out == ["ab", "cd"]


# partial_json

def test_partial_json_complete():
    assert partial_json('{"a": 1}') == {"a": 1}


def test_partial_json_open_object():
    assert partial_json('{"a": 1') == {"a": 1}


def test_partial_json_dangling_colon():
    assert partial_json('{"a":') == {"a": None}


def test_partial_json_dangling_comma():
    assert partial_json('{"a": 1,') == {"a": 1}


def test_partial_json_nested():
    assert partial_json('{"a": [1, 2,') == {"a": [1, 2]}


def test_partial_json_open_string():
    assert partial_json('{"a": "bc') == {"a": "bc"}


def test_partial_json_garbage_returns_none():
    assert partial_json("{,,}") is None


def test_partial_json_empty():
    assert partial_json("") is None


# SSE robustness

def test_utf8_split_mid_codepoint():
    raw = "data: {\"choices\":[{\"delta\":{\"content\":\"caf\u00e9. Hi!\"}}]}\n\n"
    data = raw.encode("utf-8")
    # split so an e (2 bytes) is broken across chunks
    split = data.index(b"\xc3\xa9") + 1
    out = list(
        parse_stream(
            [data[:split], data[split:]],
            buffer=BufferOptions(min_chunk_size=5),
            provider="openai",
        )
    )
    assert out == ["caf\u00e9.", "Hi!"]


def test_malformed_chunk_raises_by_default():
    with pytest.raises(LLMStreamError):
        list(
            iter_sentences(
                ["data: {broken json}\n\n"],
                on_error="raise",
            )
        )


def test_malformed_chunk_skipped():
    out = list(
        parse_stream(
            [
                "data: {broken}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"Ok fine. Done!\"}}]}\n\n",
                "data: [DONE]\n\n",
            ],
            buffer=BufferOptions(min_chunk_size=5),
            on_error="skip",
        )
    )
    assert out == ["Ok fine.", "Done!"]


# Events surface

def test_parse_events_reasoning_and_metadata():
    async def run():
        chunks = _slow_async(
            [
                "data: {\"model\":\"gpt-4o\",\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n",
            ]
        )
        out = [ev.to_dict() async for ev in parse_events(chunks)]
        return out

    events = asyncio.run(run())
    assert {"type": "reasoning_delta", "text": "thinking"} in events
    assert events[-1] == {"type": "done"}


def test_pending_property():
    buf = SentenceBuffer(BufferOptions(min_chunk_size=50))
    buf.feed("Short part")
    assert buf.pending == "Short part"