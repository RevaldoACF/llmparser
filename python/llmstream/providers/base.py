from __future__ import annotations

from typing import Any, Dict, List

from ..types import StreamEvent

__all__ = ["ProviderAdapter"]


class ProviderAdapter:
    name: str = "base"

    def map_payload(self, payload: Dict[str, Any]) -> List[StreamEvent]:
        raise NotImplementedError

    def is_done(self, payload: Dict[str, Any]) -> bool:
        """Per-payload done signal (e.g. `data: [DONE]` handled by pipeline;
        here: provider-specific in-band completion like Gemini finishReason)."""
        return False

    def finalize(self) -> List[StreamEvent]:
        """End-of-stream events (usually none; tool finalize is pipeline-side)."""
        return []

    # -- tool finalization hook
    # Adapters set `_finalize_now` inside map_payload when a per-payload tool
    # end signal is seen (e.g. finish_reason=="tool_calls", Anthropic content_block_stop of a tool_use block)
    # The pipeline drains it via take_finalize() right after each payload
    #   None      -> nothing to finalize
    #   "all"     -> finalize every slot
    #   [int, ...]-> finalize only these slot indices

    def take_finalize(self):
        scope = getattr(self, "_finalize_now", None)
        self._finalize_now = None
        return scope

    # -- shared helpers

    @staticmethod
    def _delta(text: str) -> StreamEvent:
        return StreamEvent(type="delta", text=text)

    @staticmethod
    def _reasoning(text: str) -> StreamEvent:
        return StreamEvent(type="reasoning_delta", text=text)

    @staticmethod
    def _metadata(provider: str, model: str = None, finish_reason: str = None,
                  raw: Dict[str, Any] = None) -> StreamEvent:
        return StreamEvent(
            type="metadata", provider=provider, model=model,
            finish_reason=finish_reason, raw=raw,
        )
