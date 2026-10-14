from __future__ import annotations

import json
from pathlib import Path

import pytest

from llmstream import StreamingToolParser
from llmstream.types import StreamEvent

SPEC_ROOT = Path(__file__).resolve().parent.parent.parent / "spec" / "test-vectors"

vectors = []
for p in sorted((SPEC_ROOT / "tool").glob("*.json")):
    vectors.append(pytest.param(json.loads(p.read_text(encoding="utf-8")), id=p.stem))


def _feed(parser: StreamingToolParser, slot: dict) -> None:
    index = slot.get("index", 0)
    for frag in slot.get("name_fragments", []):
        parser.on_tool_call_delta(
            StreamEvent(type="tool_call_delta", index=index, name=frag)
        )
    for frag in slot.get("argument_fragments", []):
        parser.on_tool_call_delta(
            StreamEvent(type="tool_call_delta", index=index, arguments_delta=frag)
        )


def _match(expected: dict, actual: dict) -> bool:
    for k, v in expected.items():
        if k == "type":
            if actual.get("type") != v:
                return False
            continue
        if k == "raw_arguments":
            if actual.get("raw_arguments") != v:
                return False
            continue
        if k not in actual or actual[k] != v:
            return False
    return True


@pytest.mark.parametrize("vec", vectors)
def test_tool(vec):
    parser = StreamingToolParser()
    input_ = vec["input"]
    if "slots" in input_:
        for slot in input_["slots"]:
            _feed(parser, slot)
    else:
        _feed(parser, input_)
    events = [ev.to_dict() for ev in parser.finalize()]

    expected = vec["expected"]
    if isinstance(expected, list):
        assert len(events) == len(expected), f"{len(events)} != {len(expected)}: {events}"
        for i, (e, a) in enumerate(zip(expected, events)):
            assert _match(e, a), f"event #{i}: expected {e}, got {a}"
    else:
        assert len(events) == 1, f"expected 1 event, got {events}"
        assert _match(expected, events[0]), f"expected {expected}, got {events[0]}"