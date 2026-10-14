from __future__ import annotations

import json
from pathlib import Path

import pytest

from llmstream import iter_events

SPEC_ROOT = Path(__file__).resolve().parent.parent.parent / "spec" / "test-vectors"

vectors = []
for p in sorted((SPEC_ROOT / "wire").glob("*.json")):
    vectors.append(pytest.param(json.loads(p.read_text(encoding="utf-8")), id=p.stem))


def _match(expected: dict, actual: dict) -> bool:
    for k, v in expected.items():
        if k == "type":
            if actual.get("type") != v:
                return False
            continue
        if k == "code" and actual.get("type") == "error":
            # error messages are parser-specific
            if actual.get("code") != v:
                return False
            continue
        if k not in actual:
            return False
        if actual[k] != v:
            return False
    return True


@pytest.mark.parametrize("vec", vectors)
def test_wire(vec):
    chunks = vec["chunks"]
    on_error = vec.get("on_error", "skip")
    actual = [
        ev.to_dict()
        for ev in iter_events(
            chunks,
            provider=vec.get("provider", "auto"),
            stream_format=vec.get("stream_format", "auto"),
            on_error=on_error,
        )
    ]
    expected = vec["expected_events"]
    assert len(actual) == len(expected), (
        f"event count {len(actual)} != {len(expected)}\nactual={actual}"
    )
    for i, (e, a) in enumerate(zip(expected, actual)):
        assert _match(e, a), f"event #{i}: expected {e}, got {a}"