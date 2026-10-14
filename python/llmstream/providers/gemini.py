from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ..types import StreamEvent
from .base import ProviderAdapter

__all__ = ["GeminiAdapter"]


class GeminiAdapter(ProviderAdapter):
    name = "gemini"

    def __init__(self) -> None:
        self._model: Optional[str] = None
        self._finish_emitted = False
        self._next_tool_index = 0

    def map_payload(self, payload: Dict[str, Any]) -> List[StreamEvent]:
        events: List[StreamEvent] = []
        mv = payload.get("modelVersion")
        if isinstance(mv, str) and self._model is None:
            self._model = mv

        candidates = payload.get("candidates")
        if isinstance(candidates, list) and candidates:
            c0 = candidates[0]
            if isinstance(c0, dict):
                content = c0.get("content") or {}
                parts = content.get("parts") or []
                for part in parts:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if isinstance(text, str) and text:
                        if part.get("thought") is True:
                            events.append(self._reasoning(text))
                        else:
                            events.append(self._delta(text))
                    fc = part.get("functionCall")
                    if isinstance(fc, dict) and fc.get("name"):
                        # route through the parser as a
                        args = fc.get("args")
                        events.append(
                            StreamEvent(
                                type="tool_call_delta",
                                index=self._next_tool_index,
                                name=fc["name"],
                                arguments_delta=json.dumps(args, separators=(",", ":"))
                                if args is not None
                                else "",
                            )
                        )
                        self._next_tool_index += 1
                finish = c0.get("finishReason")
                if finish and not self._finish_emitted:
                    self._finish_emitted = True
                    events.append(
                        self._metadata(self.name, model=self._model, finish_reason=finish)
                    )

        usage = payload.get("usageMetadata")
        if isinstance(usage, dict):
            events.append(
                StreamEvent(
                    type="usage",
                    input_tokens=usage.get("promptTokenCount"),
                    output_tokens=usage.get("candidatesTokenCount"),
                    total_tokens=usage.get("totalTokenCount"),
                )
            )
        return events

    def is_done(self, payload: Dict[str, Any]) -> bool:
        # finishReason set means the stream is about to end, treat as done signal
        candidates = payload.get("candidates")
        if isinstance(candidates, list) and candidates:
            c0 = candidates[0]
            if isinstance(c0, dict) and c0.get("finishReason"):
                return True
        return False