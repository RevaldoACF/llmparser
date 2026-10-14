"""

Simulates a slow LLM stream (OpenAI SSE wire format)

Swap `fake_openai_stream()` for a real client:

    async def real_openai_stream(prompt):
        async with httpx.AsyncClient() as client:
            async with client.stream(
                "POST",
                "https://api.openai.com/v1/chat/completions",
                headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
                json={"model": "gpt-4o-mini",
                      "messages": [{"role": "user", "content": prompt}],
                      "stream": True},
            ) as res:
                async for line in res.aiter_lines():
                    yield line

Run:  python examples/python_voice_agent.py
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "python"))

from llmstream import parse_stream  # noqa: E402


def sse(payload: dict) -> str:
    return f"data: {json.dumps(payload, separators=(',', ':'))}\n\n"


def chunk_delta(text: str) -> str:
    return sse({
        "object": "chat.completion.chunk",
        "choices": [{"delta": {"content": text}, "index": 0}],
    })


async def fake_openai_stream():
    """Yields the same SSE lines a real API would, word by word with gaps"""
    words = [
        "The quick brown fox jumps **over** the lazy dog! 🎉",
        "Then it keeps running, and running, and running for a very, very long time "
        "without a single stop. ",
        "At last, it rests. ",
        "Well, *almost* at last — a squirrel appears.",
    ]
    for w in words:
        for word in w.split(" "):
            yield chunk_delta(word + " ")
            await asyncio.sleep(0.06)
        await asyncio.sleep(0.35)   # gap > 500ms?
    yield sse({
        "object": "chat.completion.chunk",
        "choices": [{"delta": {}, "finish_reason": "stop", "index": 0}],
    })
    yield "data: [DONE]\n\n"


def main() -> None:
    async def run():
        print("— voice agent —")
        n = 0
        # sentence strategy + 500ms idle flush + strip markdown/emoji
        async for sentence in parse_stream(fake_openai_stream(), buffer="voice"):
            n += 1
            # In a real app: tts.speak(sentence)
            print(f"[tts #{n}] {sentence!r}")

    asyncio.run(run())


if __name__ == "__main__":
    main()