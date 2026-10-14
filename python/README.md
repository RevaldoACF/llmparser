# llmstream (Python)

Parse LLM streaming responses into **clean, complete sentences** — multi-provider, zero dependencies, one call. Python 3.9+.

**Part of the [llmstream](../README.md) monorepo** (Python + JS/TS, spec-first, shared test vectors).

## Install

```bash
cd python
pip install -e .              # or: pip install .
pip install -e ".[dev]"       # + pytest / pytest-asyncio for the test suite
```

> **Zero runtime dependencies.** The package imports only from the standard library.
> You bring your own HTTP client (httpx, aiohttp, the provider SDK, `requests`…) and feed us the chunks.

## Quick start — Voice AI

`parse_stream` is the one-call entry point. It auto-detects the provider and wire format, and applies the `"voice"` buffer preset (sentence strategy + 500 ms idle flush + markdown/emoji stripping) by default.

```python
import asyncio
import httpx
from llmstream import parse_stream

async def openai_stream(messages: list[dict]) -> "AsyncIterator[bytes]":
    """Your raw chunk iterator — anything that yields bytes/str/dicts."""
    async with httpx.AsyncClient() as client:
        async with client.stream(
            "POST",
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={"model": "gpt-4o-mini", "messages": messages, "stream": True},
        ) as res:
            async for line in res.aiter_lines():
                yield line.encode() if isinstance(line, str) else line

async def main():
    async for sentence in parse_stream(openai_stream([{"role": "user", "content": "Why is the sky blue?"}])):
        tts.speak(sentence)          # each `sentence` is a complete, TTS-clean sentence

asyncio.run(main())
```

That's the entire integration: **one import, one call, no configuration**.

## The `@stream_parser` decorator

Wrap any generator that yields raw chunks so it yields sentences instead:

```python
from llmstream import stream_parser

@stream_parser(buffer="voice")          # or buffer="ui", "off", False, BufferOptions(...)
async def chat(prompt: str):
    async for chunk in raw_openai_stream(prompt):   # bytes / str / pre-parsed dicts
        yield chunk

async for sentence in chat("Hello!"):
    tts.speak(sentence)
```

Works for **sync generators too** (the decorator detects `async def` vs `def`):

```python
@stream_parser(buffer="ui")
def chat_sync(prompt: str):
    for chunk in requests_stream(prompt):
        yield chunk
```

## Choosing providers (optional)

Provider and wire format are auto-detected from the first parseable payload:

| Provider | Detection signal |
|---|---|
| `openai` | `choices[].delta` or `object == "chat.completion.chunk"` |
| `anthropic` | `type` field in Anthropic event set |
| `gemini` | `candidates[]` payload |
| `groq` | `x_groq` field (otherwise OpenAI-compatible — you can force it) |
| `generic` | anything else (Ollama, OpenRouter, vLLM, any OpenAI-compatible endpoint) |

Override when you know better:

```python
# Force the Groq adapter (OpenAI wire):
parse_stream(chunks, provider="groq")

# Generic adapter with a custom text path (dotted lookup), e.g. Ollama:
parse_stream(chunks, provider="generic", text_path="message.content")

# Force the wire format: "sse" or "jsonl" (default "auto" = SSE, fallback JSONL)
parse_stream(chunks, stream_format="jsonl")
```

## Working with raw events

`parse_stream` yields **sentences** (str). Use `parse_events` / `iter_events` to get the normalized `StreamEvent` stream — needed when you want tool calls, usage, or metadata:

```python
from llmstream import parse_events, iter_events

# Async:
async for ev in parse_events(chunks, provider="auto"):
    if ev.type == "delta":
        print(ev.text, end="")
    elif ev.type == "reasoning_delta":
        thinking.append(ev.text)
    elif ev.type == "tool_call_complete":
        run_tool(ev.name, ev.arguments)          # validated JSON object
    elif ev.type == "usage":
        log(ev.input_tokens, ev.output_tokens)
    elif ev.type == "metadata":
        print(ev.model, ev.finish_reason)
    elif ev.type == "error":
        print(ev.code, ev.message)
    elif ev.type == "done":
        break

# Sync (works with plain iterables, files, lists of strings/bytes/dicts):
for ev in iter_events(lines_from_file):
    ...
```

The sentence API is just `iter_sentences` on top of the same core:

```python
for sentence in iter_sentences(chunks, buffer="voice"):
    print(sentence)
```

### `StreamEvent` fields

| Field | Event types |
|---|---|
| `text` | `delta`, `reasoning_delta` |
| `index`, `id`, `name`, `arguments_delta` | `tool_call_delta` |
| `index`, `id`, `name`, `arguments`, `raw_arguments` | `tool_call_complete` |
| `input_tokens`, `output_tokens`, `total_tokens` | `usage` |
| `provider`, `model`, `finish_reason` | `metadata` |
| `code`, `message`, `provider_error` | `error` |

## Tool calls

The pipeline assembles fragmented tool-call arguments **per slot (by index)** and emits `tool_call_complete` **only after strict JSON validation** — empty arguments become `{}`, invalid JSON produces an `error` event with `code="tool_arguments_invalid"` instead of a broken call.

If you only want sentences, tool fragments are transparently consumed. If you want the calls, listen on `parse_events` (above) — no extra wiring needed.

For low-level control (or to power your own UI), use the parser directly:

```python
from llmstream import StreamingToolParser, partial_json

parser = StreamingToolParser()

def on_progress(index, partial: dict | None):
    # Live preview of the still-incomplete arguments (display only — never valid yet)
    print("assembling…", partial)

for ev in events:
    if ev.type == "tool_call_delta":
        parser.on_tool_call_delta(ev, on_progress=on_progress)
    # …at end-of-stream (or on the provider's per-tool end signal):
    for done in parser.finalize():            # indices=None -> all slots, ascending
        print(done.name, done.arguments)
```

`partial_json('{"a": 1, "b": ')` → `{"a": 1, "b": null}` — a best-effort, **display-only** completion that never gates dispatch.

## Buffer options

`buffer` accepts a preset (`"voice"`, `"ui"`, `"off"`/`False`) or a `BufferOptions` instance:

```python
from llmstream import BufferOptions, parse_stream

opts = BufferOptions(
    min_chunk_size=40,        # don't flush sentences shorter than this (codepoints)
    max_buffer_size=400,      # force-flush ceiling so the buffer never piles up
    idle_timeout=0.5,         # flush after 0.5s of silence (async pipelines only)
    strategy="sentence",      # sentence | clause | fixed | "regex:<pattern>"
    sentence_enders=". ! ? … 。 ！",   # NOTE: spaces are separators, not boundary chars
    soft_boundary=", ; : —",
    strip_markdown=True,      # headings, lists, links (label kept), emphasis…
    strip_emoji=True,         # emoji + variation selectors stripped for TTS
    collapse_whitespace=True,
    guard_tags=["```", "~~~", "`"],
    guard_tags_extra=["<pause>", "[laugh]"],  # your custom TTS control tags
    code_block_mode="passthrough",  # passthrough | drop | sanitize ("(code)")
    additional_abbrevs=["vs", "etc", "approx"],
    on_error="raise",         # raise | skip
)
async for sentence in parse_stream(chunks, buffer=opts):
    ...
```

**How the buffer works** (full normative spec: [../spec/BUFFER-ALGORITHM.md](../spec/BUFFER-ALGORITHM.md)):

1. Text accumulates in a buffer. A sentence boundary is a valid ender (`.!?…。！`) **not** part of an abbreviation (Rule A) **not** a decimal/token dot (Rule U), followed by whitespace/EOF/closing punctuation (Rule F).
2. A flushed region must be ≥ `min_chunk_size` codepoints, otherwise it's held for the next boundary.
3. If the buffer reaches `max_buffer_size` with no valid boundary, it's force-flushed (cut at the limit).
4. **Tag guard**: if the buffer ends in a proper prefix of a guarded tag (`` ` ``, `$$`, a fence, `<pause>`…), the text is withheld until the tag completes — so TTS never reads half a tag or half a code fence.
5. **Idle timeout** (async only): if the stream pauses with text still held, it's flushed so speech latency stays low.

### `SentenceBuffer` standalone

```python
from llmstream import SentenceBuffer

buf = SentenceBuffer(opts)
for s in buf.feed("The quick brown fox"):      # -> [] (not a sentence yet)
    ...
for s in buf.feed(" jumps. Then it ran fast."):
    print(s)        # "The quick brown fox jumps." / "Then it ran fast."
for s in buf.close():
    print(s)        # any trailing partial text
```

## Error handling

- `on_error="raise"` (default): malformed chunks raise `ProtocolError`; bad tool JSON raises `ToolArgumentsError`; provider-level errors raise `ProviderError`. All derive from `LLMStreamError`.
- `on_error="skip"`: errors are emitted as `error` events (`code` ∈ `malformed_chunk`, `tool_arguments_invalid`, `provider_error`) and the stream continues.

```python
from llmstream import LLMStreamError

try:
    for ev in iter_events(chunks):
        ...
except LLMStreamError as e:
    print(type(e).__name__, e)
```

## Object-style API (optional)

```python
from llmstream import Pipeline

p = Pipeline(provider="auto", buffer="voice", on_error="skip")
for sentence in p.sentences(chunks):   # sync or async input
    ...
for ev in p.events(chunks):
    ...
```

## Tests

```bash
cd python
python -m pytest tests/ -q        # 54 tests: shared vectors + unit tests
```

The vector tests load `../spec/test-vectors/` — the **same** vectors the JS suite runs, which is how cross-language parity is enforced.

## Module map

| Module | Contents |
|---|---|
| `llmstream/pipeline.py` | `parse_stream`, `parse_events`, `iter_events`, `iter_sentences`, `@stream_parser`, `Pipeline`, `ParserCore` |
| `llmstream/buffer.py` | `SentenceBuffer`, `sanitize_for_tts`, `withhold_len` |
| `llmstream/tool_parser.py` | `StreamingToolParser`, `ToolSlot`, `partial_json` |
| `llmstream/providers/` | `OpenAIAdapter`, `AnthropicAdapter`, `GeminiAdapter`, `GroqAdapter`, `GenericAdapter`, `detect_provider`, `create_adapter` |
| `llmstream/decoders.py` | `SSEDecoder`, `JsonLinesDecoder` (incremental, UTF-8-safe) |
| `llmstream/types.py` | `StreamEvent`, `BufferOptions`, `ToolCall`, presets |
| `llmstream/errors.py` | `LLMStreamError` hierarchy |