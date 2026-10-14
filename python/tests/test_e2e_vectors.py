from __future__ import annotations
import json
from dataclasses import fields
from pathlib import Path

import pytest

from llmstream import iter_sentences
from llmstream.types import BufferOptions

SPEC_ROOT = Path(__file__).resolve().parent.parent.parent / "spec" / "test-vectors"

vectors = []
for p in sorted((SPEC_ROOT / "e2e").glob("*.json")):
    vectors.append(pytest.param(json.loads(p.read_text(encoding="utf-8")), id=p.stem))

_OPTION_FIELDS = {f.name for f in fields(BufferOptions)}


@pytest.mark.parametrize("vec", vectors)
def test_e2e(vec):
    out = list(
        iter_sentences(
            vec["chunks"],
            provider=vec.get("provider", "auto"),
            buffer=BufferOptions(**{k: v for k, v in vec.get("options", {}).items() if k in _OPTION_FIELDS}),
            on_error=vec.get("on_error", "skip"),
        )
    )
    expected = vec["expected_sentences"]
    assert out == expected, f"sentences {out} != {expected}"