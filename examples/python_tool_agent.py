"""
Shows how `parse_events` assembles fragmented tool-call arguments in real
time and emits `tool_call_complete` ONLY after strict JSON validation
your tool handlers are never invoked with broken/partial arguments

Run:  python examples/python_tool_agent.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from llmstream import iter_events  # noqa: E402


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


def tool_delta(index: int, tc: dict) -> str:
    return sse({
        "object": "chat.completion.chunk",
        "choices": [{"delta": {"tool_calls": [tc]}, "index": 0}],
    })


def frag_args(index: int, pieces: list[str]) -> list[str]:
    out = []
    for i, piece in enumerate(pieces):
        tc = {"index": index, "type": "function"}
        if i == 0:
            tc["id"] = f"call_{index}"
        tc["function"] = {}
        if i == 0:
            tc["function"]["name"] = "get_weather" if index == 0 else "get_forecast"
        tc["function"]["arguments"] = piece
        out.append(tool_delta(index, tc))
    return out


SSE_LINES = [
    # --- tool call 0: get_weather, args fragmented across deltas ---
    *frag_args(0, ['{"city": "Ja', 'karta", "unit": ', '"celsius"}']),
    # --- tool call 1: get_forecast, starts BEFORE call 0 finishes ---
    *frag_args(1, ['{"days": 3, "city"', ': "Jakarta"}']),
    # --- text delta ---
    sse({"object": "chat.completion.chunk",
         "choices": [{"delta": {"content": "Here is your weather!"}, "index": 0}]}),
    # --- finish ---
    sse({"object": "chat.completion.chunk",
         "choices": [{"delta": {}, "finish_reason": "tool_calls", "index": 0}]}),
    "data: [DONE]\n\n",
]


TOOLS = {
    "get_weather": lambda **kw: f"🌤 {kw['city']}: 31°C ({kw['unit']})",
    "get_forecast": lambda **kw: f"🌦 {kw['days']} days for {kw['city']}: sunny",
}


def main() -> None:
    print("— tool agent —")
    for ev in iter_events(SSE_LINES, provider="openai"):
        if ev.type == "delta":
            print(f"[text] {ev.text}")
        elif ev.type == "tool_call_complete":
            # `ev.arguments` is a fully validated JSON object
            print(f"[tool] {ev.name}({ev.arguments})")
            fn = TOOLS.get(ev.name)
            if fn is not None:
                print(f"[result] {fn(**ev.arguments)}")
        elif ev.type == "error":
            # malformed tool JSON surfaces (code="tool_arguments_invalid")
            print(f"[error] {ev.code}: {ev.message}")
        elif ev.type == "metadata":
            print(f"[meta] finish_reason={ev.finish_reason}")
        elif ev.type == "done":
            pass


if __name__ == "__main__":
    main()