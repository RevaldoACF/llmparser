from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..types import StreamEvent
from .base import ProviderAdapter

__all__ = ["AnthropicAdapter"]


class AnthropicAdapter(ProviderAdapter):
    name = "anthropic"

    def __init__(self) -> None:
        # content block type per index (text | tool_use | thinking), captured at content_block_start
        self._block_types: Dict[int, str] = {}
        self._block_ids: Dict[int, str] = {}
        self._block_names: Dict[int, str] = {}
        self._name_sent: set = set()
        self._model: Optional[str] = None
        self._finalize_now = None

    def map_payload(self, payload: Dict[str, Any]) -> List[StreamEvent]:
        ptype = payload.get("type")
        if ptype == "message_start":
            msg = payload.get("message") or {}
            model = msg.get("model")
            if isinstance(model, str):
                self._model = model
                return [self._metadata(self.name, model=model)]
            return []
        if ptype == "content_block_start":
            idx = int(payload.get("index", 0))
            block = payload.get("content_block") or {}
            btype = block.get("type", "")
            self._block_types[idx] = btype
            if block.get("id") is not None:
                self._block_ids[idx] = block["id"]
            if block.get("name"):
                self._block_names[idx] = block["name"]
            return []
        if ptype == "content_block_delta":
            idx = int(payload.get("index", 0))
            d = payload.get("delta") or {}
            dtype = d.get("type")
            if dtype == "text_delta":
                text = d.get("text")
                if isinstance(text, str) and text:
                    return [self._delta(text)]
            elif dtype == "thinking_delta":
                text = d.get("thinking")
                if isinstance(text, str) and text:
                    return [self._reasoning(text)]
            elif dtype == "input_json_delta":
                pj = d.get("partial_json")
                if isinstance(pj, str) and pj:
                    ev = StreamEvent(type="tool_call_delta", index=idx)
                    if idx in self._block_ids:
                        ev.id = self._block_ids[idx]
                    # name arrives once at content_block_start, don't repeat it
                    # on every fragment (parser concatenates name fragments)
                    if idx in self._block_names and idx not in self._name_sent:
                        ev.name = self._block_names[idx]
                        self._name_sent.add(idx)
                    ev.arguments_delta = pj
                    return [ev]
            return []
        if ptype == "content_block_stop":
            idx = int(payload.get("index", 0))
            if self._block_types.get(idx) == "tool_use":
                self._finalize_now = [idx]
            return []
        if ptype == "message_delta":
            events: List[StreamEvent] = []
            usage = payload.get("usage")
            if isinstance(usage, dict):
                events.append(
                    StreamEvent(
                        type="usage",
                        input_tokens=usage.get("input_tokens"),
                        output_tokens=usage.get("output_tokens"),
                    )
                )
            d = payload.get("delta") or {}
            stop = d.get("stop_reason")
            if stop:
                events.append(self._metadata(self.name, model=self._model, finish_reason=stop))
            return events
        if ptype == "error":
            err = payload.get("error") or {}
            return [
                StreamEvent(
                    type="error",
                    code=err.get("type", "provider_error"),
                    message=err.get("message", ""),
                    provider_error=payload,
                )
            ]
        # message_stop / ping / unknown -> no event
        return []

    def is_done(self, payload: Dict[str, Any]) -> bool:
        return payload.get("type") == "message_stop"

    def block_is_tool_use(self, index: int) -> bool:
        return self._block_types.get(index) == "tool_use"