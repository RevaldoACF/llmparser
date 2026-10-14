# llmstream examples

Three runnable examples. The two Python ones are **fully self-contained** (no
network, no API key — they simulate realistic LLM streams in memory).

## 1. `python_voice_agent.py` — Voice AI

A simulated OpenAI SSE stream is fed through `parse_stream` with the `"voice"`
preset. You'll see text held until each sentence is complete (including across
the long run-on sentence), markdown/emoji stripped, and the idle-timeout
flushing text when the stream pauses.

```bash
python examples/python_voice_agent.py
```

To use a real model, replace `fake_openai_stream()` with your own async
generator (the file's docstring shows the exact `httpx` replacement).

## 2. `python_tool_agent.py` — streaming tool calls

A realistic OpenAI SSE stream where the tool-argument JSON is **split across
many deltas** and two parallel tool calls are interleaved. `iter_events`
assembles them and emits `tool_call_complete` **only after strict JSON
validation**, so the demo's `run_tool` handlers always receive complete,
valid arguments.

```bash
python examples/python_tool_agent.py
```

## 3. `react-live-caption/` — React live caption demo

A Vite + React app using the `useLLMStream` hook. It streams from a **local
mock SSE endpoint** served by a tiny Vite middleware plugin — no network, no
API key — and shows:

- **Live captions**: complete sentences appear as whole lines; the in-progress
  `partial` text renders with a blinking caret (throttled ~30 fps).
- **Speech**: a "speak" toggle routes each complete sentence to the browser
  `speechSynthesis` (the Voice AI use case).
- **Tag guard + sanitizer**: the mock stream contains `**bold**`, a fenced
  code block, and emoji — all handled.
- **Tool calls**: the mock stream also emits a fragmented tool call, shown in
  the "Validated tool calls" panel.
- **Stop / status**: abort mid-stream and watch the lifecycle
  (`idle → streaming → done`).

```bash
cd examples/react-live-caption
npm install
npm run dev        # open the printed localhost URL
```

To use a real model, point `start(...)` in `src/App.tsx` at your own
OpenAI-compatible streaming endpoint (the current call uses `/mock-sse`).