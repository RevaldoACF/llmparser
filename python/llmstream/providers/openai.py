from __future__ import annotations

from typing import Any, Dict, List

from ..types import StreamEvent
from .base import ProviderAdapter

__all__ = ["OpenAIAdapter", "GroqAdapter"]


class OpenAIAdapter(ProviderAdapter):
    name = "openai"

    def __init__(self, provider: str = "openai") -> None:
        self.name = provider
        self._model: str | None = None
        self._finalize_now = None

    def map_payload(self, payload: Dict[str, Any]) -> List[StreamEvent]:
        events: List[StreamEvent] = []
        model = payload.get("model")
        if isinstance(model, str) and self._model is None:
            self._model = model

        choices = payload.get("choices")
        if isinstance(choices, list) and choices:
            c0 = choices[0]
            if isinstance(c0, dict):
                delta = c0.get("delta") or {}
                content = delta.get("content")
                if isinstance(content, str) and content:
                    events.append(self._delta(content))
                # Some OpenAI-compatible proxies (e.g. one-api) emit the
                # thinking text under "reasoning" instead of the standard
                # "reasoning_content"; accept both.
                reasoning = delta.get("reasoning_content")
                if not (isinstance(reasoning, str) and reasoning):
                    reasoning = delta.get("reasoning")
                if isinstance(reasoning, str) and reasoning:
                    events.append(self._reasoning(reasoning))
                tool_calls = delta.get("tool_calls")
                if isinstance(tool_calls, list):
                    for tc in tool_calls:
                        if not isinstance(tc, dict):
                            continue
                        ev = StreamEvent(type="tool_call_delta", index=int(tc.get("index", 0)))
                        if tc.get("id") is not None:
                            ev.id = tc["id"]
                        fn = tc.get("function") or {}
                        if fn.get("name"):
                            ev.name = fn["name"]
                        if fn.get("arguments"):
                            ev.arguments_delta = fn["arguments"]
                        events.append(ev)
                finish = c0.get("finish_reason")
                if finish:
                    events.append(
                        self._metadata(self.name, model=self._model, finish_reason=finish)
                    )
                    if finish == "tool_calls":
                        self._finalize_now = "all"

        usage = payload.get("usage")
        if isinstance(usage, dict):
            events.append(
                StreamEvent(
                    type="usage",
                    input_tokens=usage.get("prompt_tokens"),
                    output_tokens=usage.get("completion_tokens"),
                    total_tokens=usage.get("total_tokens"),
                )
            )
        # Groq-style usage variants
        x_groq = payload.get("x_groq")
        if isinstance(x_groq, dict):
            u = x_groq.get("usage")
            if isinstance(u, dict):
                events.append(
                    StreamEvent(
                        type="usage",
                        input_tokens=u.get("prompt_tokens"),
                        output_tokens=u.get("completion_tokens"),
                        total_tokens=u.get("total_tokens"),
                    )
                )
        return events


class GroqAdapter(OpenAIAdapter):
    name = "groq"

    def __init__(self) -> None:
        super().__init__("groq")