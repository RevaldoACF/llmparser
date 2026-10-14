from __future__ import annotations

import json
from pathlib import Path

import pytest

SPEC_ROOT = Path(__file__).resolve().parent.parent.parent / "spec" / "test-vectors"


def _load(layer: str):
    out = []
    d = SPEC_ROOT / layer
    if not d.is_dir():
        return out
    for p in sorted(d.glob("*.json")):
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        out.append((data["name"], data))
    return out


def _ids(items):
    return [name for name, _ in items]


@pytest.fixture(scope="session")
def wire_vectors():
    return _load("wire")


@pytest.fixture(scope="session")
def buffer_vectors():
    return _load("buffer")


@pytest.fixture(scope="session")
def tool_vectors():
    return _load("tool")


@pytest.fixture(scope="session")
def e2e_vectors():
    return _load("e2e")


def parametrize(fixture_name, argnames):
    return pytest.mark.parametrize(fixture_name, _load(fixture_name), ids=None)