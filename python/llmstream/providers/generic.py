from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ..types import StreamEvent
from .base import ProviderAdapter

__all__ = ["GenericAdapter", "DEFAULT_TEXT_PATHS", "DEFAULT_TOOL_PATH"]

#: Common text paths tried in order (first hit wins)
DEFAULT_TEXT_PATHS: List[str] = [
    "choices.0.delta.content",
    "delta.text",
    "candidates.0.content.parts.0.text",
    "message.content",
    "response",
    "text",
    "output",
    "completion",
]

DEFAULT_TOOL_PATH = "tool"


def resolve_path(obj: Any, path: str) -> Any:
    """Dotted path lookup (int segments index lists). Returns None when missing"""
    cur = obj
    for seg in path.split("."):
        if cur is None:
            return None
        try:
            if isinstance(cur, list):
                cur = cur[int(seg)]
            elif isinstance(cur, dict):
                cur = cur.get(seg)
            else:
                return None
        except (KeyError, IndexError, ValueError):
            return None
    return cur


class GenericAdapter(ProviderAdapter):
    name = "generic"

    def __init__(
        self,
        text_path: Optional[str] = None,
        tool_path: Optional[str] = None,
    ) -> None:
        self._text_path = text_path
        self._tool_path = tool_path
        self._resolved_text_path: Optional[str] = None
        self._next_tool_index = 0
        self._model: Optional[str] = None
        self._finish_reason: Optional[str] = None

    def map_payload(self, payload: Dict[str, Any]) -> List[StreamEvent]:
        events: List[StreamEvent] = []
        if not isinstance(payload, dict):
            return events

        if self._model is None and isinstance(payload.get("model"), str):
            self._model = payload["model"]

        # Error payloads
        if "error" in payload and not any(p in payload for p in ("choices", "candidates")):
            err = payload["error"]
            if isinstance(err, dict):
                return [
                    StreamEvent(
                        type="error",
                        code=err.get("type") or err.get("code") or "provider_error",
                        message=str(err.get("message", "")),
                        provider_error=payload,
                    )
                ]
            return [StreamEvent(type="error", code="provider_error", message=str(err), provider_error=payload)]

        # Text
        paths = [self._text_path] if self._text_path else DEFAULT_TEXT_PATHS
        text = None
        for p in paths:
            v = resolve_path(payload, p)
            if isinstance(v, str) and v:
                text = v
                if self._resolved_text_path is None:
                    self._resolved_text_path = p
                break
        if text:
            events.append(self._delta(text))

        # Optional tool fragments
        tool_src = self._tool_path or DEFAULT_TOOL_PATH
        tool = resolve_path(payload, tool_src) if self._tool_path else payload.get(DEFAULT_TOOL_PATH)
        if isinstance(tool, dict) and (tool.get("name") or tool.get("arguments") is not None):
            args = tool.get("arguments")
            if isinstance(args, str):
                raw = args
            elif args is not None:
                raw = json.dumps(args, separators=(",", ":"))
            else:
                raw = ""
            events.append(
                StreamEvent(
                    type="tool_call_delta",
                    index=self._next_tool_index,
                    name=tool.get("name", ""),
                    arguments_delta=raw,
                )
            )
            self._next_tool_index += 1

        # Done flags (Ollama-style) and finish reasons
        fr = payload.get("finish_reason") or payload.get("finishReason")
        if fr and not self._finish_reason:
            self._finish_reason = fr
        if payload.get("done") is True or fr:
            events.append(
                StreamEvent(
                    type="metadata",
                    provider="generic",
                    model=self._model,
                    finish_reason=fr or "stop",
                )
            )
        return events

    def is_done(self, payload: Dict[str, Any]) -> bool:
        return payload.get("done") is True
