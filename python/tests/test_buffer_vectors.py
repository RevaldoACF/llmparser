from __future__ import annotations

import json
from dataclasses import fields
from pathlib import Path

import pytest

from llmstream import SentenceBuffer
from llmstream.types import BufferOptions

SPEC_ROOT = Path(__file__).resolve().parent.parent.parent / "spec" / "test-vectors"

vectors = []
for p in sorted((SPEC_ROOT / "buffer").glob("*.json")):
    vectors.append(pytest.param(json.loads(p.read_text(encoding="utf-8")), id=p.stem))

_OPTION_FIELDS = {f.name for f in fields(BufferOptions)}


def _opts_from(raw: dict) -> BufferOptions:
    return BufferOptions(**{k: v for k, v in raw.items() if k in _OPTION_FIELDS})


@pytest.mark.parametrize("vec", vectors)
def test_buffer(vec):
    buf = SentenceBuffer(_opts_from(vec.get("options", {})))
    out = []
    for token in vec["input"]["tokens"]:
        out.extend(buf.feed(token))
    out.extend(buf.close())
    expected = vec["expected_sentences"]
    assert out == expected, f"sentences {out} != {expected}"