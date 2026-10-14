from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional

from .types import StreamEvent

__all__ = ["ToolSlot", "StreamingToolParser", "partial_json"]


@dataclass
class ToolSlot:
    index: int
    id: Optional[str] = None
    name: str = ""
    args: str = ""
    finalized: bool = False


class StreamingToolParser:
    """Per-stream stateful assembler"""

    def __init__(self) -> None:
        self._slots: Dict[int, ToolSlot] = {}

    def reset(self) -> None:
        self._slots.clear()

    # -- event handling

    def on_tool_call_delta(self, ev: StreamEvent, on_progress=None) -> None:
        slot = self._slots.get(ev.index)
        if slot is None:
            slot = ToolSlot(index=ev.index)
            self._slots[ev.index] = slot
        if slot.finalized:
            return  # ignore (idempotent finalize)
        if ev.id is not None:
            slot.id = ev.id
        if ev.name:
            slot.name += ev.name
        if ev.arguments_delta:
            slot.args += ev.arguments_delta
        if on_progress is not None:
            on_progress(slot.index, partial_json(slot.args))

    def finalize(self, indices: Optional[List[int]] = None) -> Iterator[StreamEvent]:
        """
        indices=None -> all slots
        (per-payload tool end signals, e.g. one Anthropic content_block_stop).
        """
        for index in sorted(self._slots.keys()):
            if indices is not None and index not in indices:
                continue
            slot = self._slots[index]
            if slot.finalized:
                continue
            slot.finalized = True
            if slot.name == "" and slot.args == "":
                continue  # phantom empty slot
            if slot.args == "":
                yield StreamEvent(
                    type="tool_call_complete",
                    index=index,
                    id=slot.id,
                    name=slot.name,
                    arguments={},
                    raw_arguments="",
                )
                continue
            try:
                obj = json.loads(slot.args)
                if not isinstance(obj, dict):
                    raise ValueError("expected a JSON object")
            except (json.JSONDecodeError, ValueError) as e:
                brief = getattr(e, "msg", "") or str(e)
                yield StreamEvent(
                    type="error",
                    code="tool_arguments_invalid",
                    message=f"invalid tool arguments for '{slot.name}': {brief}".strip(),
                    raw_arguments=slot.args,
                    index=index,
                )
                continue
            yield StreamEvent(
                type="tool_call_complete",
                index=index,
                id=slot.id,
                name=slot.name,
                arguments=obj,
                raw_arguments=slot.args,
            )

    @property
    def slots(self) -> Dict[int, ToolSlot]:
        return dict(self._slots)


# partial_json — best-effort completion for progressive UI (spec §4)
# Display-only. NEVER gates dispatch.

def partial_json(s: str) -> Optional[Any]:
    """Try to parse `s` if incomplete, append the minimal closing sequence
    (unterminated string close, dangling `:` -> null, dangling `,` drop,
    unclosed brackets) and retry. Returns the parsed value or None."""
    if not s:
        return None
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    in_string = False
    escape = False
    stack: List[str] = []
    for ch in s:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            stack.append(ch)
        elif ch == "}":
            if stack and stack[-1] == "{":
                stack.pop()
        elif ch == "]":
            if stack and stack[-1] == "[":
                stack.pop()

    fixups = ""
    if in_string:
        fixups += '"'
    # trim dangling comma / colon
    t = s.rstrip()
    if t.endswith(","):
        t = t[:-1]
    elif t.endswith(":"):
        # keep the colon 'null' is inserted right after it
        fixups = "null" + fixups
    closers = "".join("}" if b == "{" else "]" for b in reversed(stack))
    candidate = t + fixups + closers
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None