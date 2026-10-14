<p align="center">
  <img src="docs/images/banner.svg" alt="LLMParsor" width="760" />
</p>

<p align="center">
  <strong>Turn any LLM stream into clean, complete sentences. In Python and JavaScript. In one line.</strong>
</p>

<p align="center">
  <img alt="Python" src="https://img.shields.io/badge/Python-3.9%2B-3776ab?logo=python&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ESM%20%2B%20CJS-3178c6?logo=typescript&logoColor=white" />
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-zero-3fb950" />
  <img alt="Tests" src="https://img.shields.io/badge/tests-107%20passing-3fb950?logo=pytest" />
  <img alt="License" src="https://img.shields.io/badge/license-MIT-e3b341" />
</p>

<p align="center">
  <sub><a href="#why-this-library">Why</a> · <a href="#how-it-works">How it works</a> · <a href="#quick-start-python">Python</a> · <a href="#quick-start-javascript">JavaScript</a> · <a href="#quick-start-react">React</a> · <a href="#the-sentence-buffer-step-by-step">Buffer</a> · <a href="#tool-calls-assembled-in-real-time">Tool calls</a> · <a href="#provider-auto-detection">Providers</a> · <a href="#examples">Examples</a></sub>
</p>

<br>

When an LLM streams an answer, it sends tiny pieces of text, a few characters at a time. That is a problem for Voice AI. If you send `"The"` to the text to speech engine, then `"sky"`, then `"is"`, the voice sounds robotic and broken. You want to send `"The sky is blue."` as one piece, so it sounds like a real person talking.

`llmstream` solves exactly that. It takes the raw stream from any provider, waits until a sentence is complete, cleans it up, and hands it to you. Your app just speaks or displays each sentence.

It also solves two more streaming problems that catch everyone:

1. **Tool calls arrive in pieces.** The JSON arguments for a tool call come in tiny fragments. `llmstream` glues them together and only calls your function when the JSON is 100% valid.
2. **Code blocks and tags get cut in half.** A fence like ` ``` ` can arrive split across two chunks. `llmstream` notices this and holds the text until the tag or block is whole, so your TTS never reads half a tag out loud.

## Why this library

| | |
|---|---|
| **It is tiny.** | Zero runtime dependencies in Python. Zero runtime dependencies in JavaScript. It only uses what your language already has. |
| **It is easy.** | One import, one function call. No config, no setup. It even figures out which provider you are using by itself. |
| **It works with almost every provider.** | OpenAI, Anthropic, Google Gemini, Groq, and a generic adapter for Ollama, OpenRouter, VLLM, or any OpenAI compatible API. |
| **Python and JavaScript behave identically.** | Both run the same test vectors. If they ever disagree, that is a bug we fix. |

## How it works

<p align="center">
  <img src="docs/images/pipeline-overview.svg" alt="How llmstream works" width="920" />
</p>

Five steps, all inside one function call:

1. **Raw stream.** Bytes or strings from the API, whatever shape they are in.
2. **Wire decoder.** Understands Server Sent Events (SSE) and JSON Lines, even when a chunk is cut in the middle of a word or a UTF-8 character.
3. **Provider adapter.** Turns the provider specific format into one universal event format (text, reasoning, tools, usage, errors). The provider is detected automatically.
4. **Sentence buffer.** The smart part. It holds text until a sentence is complete, then cleans it for TTS (no markdown, no emoji).
5. **Done.** You get clean sentences, ready to speak or display.

<a name="quick-start-python"></a>

## Quick start: Python

```python
from llmstream import parse_stream

async def main():
    chunks = openai_stream(...)          # your raw chunk iterator
    async for sentence in parse_stream(chunks):
        tts.speak(sentence)              # whole sentences, natural intonation
```

That is the entire integration. Provider detection, wire decoding, sentence buffering, and TTS cleaning all happen inside `parse_stream`.

You can also use it as a decorator, so your own generator yields sentences:

```python
from llmstream import stream_parser

@stream_parser(buffer="voice")
async def chat(prompt):
    async for chunk in raw_stream(prompt):
        yield chunk

async for sentence in chat("Hello!"):
    tts.speak(sentence)
```

Full Python guide: [python/README.md](python/README.md)

<a name="quick-start-javascript"></a>

## Quick start: JavaScript

```js
import { parseStream } from "llmstream";

const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });

for await (const sentence of parseStream(res.body)) {
  tts.speak(sentence);
}
```

It accepts a `ReadableStream`, an async iterable, or a plain iterable. The JavaScript API also has:

- `wrapStream` : the JS version of the decorator.
- `sentenceTransform` : a `TransformStream` you can pipe a response straight into.
- `useLLMStream` : a React hook with live captions, speech, tool calls, and a stop button.

Full JavaScript guide: [js/README.md](js/README.md)

<a name="quick-start-react"></a>

## Quick start: React

```tsx
import { useLLMStream } from "llmstream/react";

function VoiceChat() {
  const { sentences, partial, status, start, abort } = useLLMStream({
    buffer: "voice",
    onSentence: (s) => tts.speak(s),        // each complete sentence
  });

  return (
    <div>
      {sentences.map((s, i) => <p key={i}>{s}</p>)}
      <span>{partial}</span>                // live in progress text
      <button onClick={() => start("/api/chat", { body })}>Send</button>
      <button onClick={abort}>Stop</button>
    </div>
  );
}
```

There is a ready to run demo at [examples/react-live-caption](examples/react-live-caption). It uses a local mock stream, so you can try it with no API key and no network.

<a name="the-sentence-buffer-step-by-step"></a>

## The sentence buffer, step by step

This is the heart of the library, drawn as a picture:

<p align="center">
  <img src="docs/images/sentence-buffer.svg" alt="The sentence buffer, step by step" width="920" />
</p>

In plain words:

- **Tag guard.** If the buffer ends with something that looks like the start of a tag or a fence (for example ` `` ` or `<p`), it waits. That way you never get a half tag.
- **Code blocks.** Once a code block opens, it is handled as a unit. You can pass it through raw, drop it, or replace it with the word "(code)" so TTS does not read code aloud.
- **Complete sentence.** The scanner looks for a real end of sentence (`. ! ? … 。 ！`). It knows that `"Mr."` is not the end of a sentence, and that the dot in `"3.14"` is not a sentence break either.
- **Not too short.** A sentence shorter than 40 codepoints is merged with the next one, so TTS does not speak tiny fragments.
- **Not too long.** If the buffer reaches 400 codepoints without a sentence break, it is force flushed. Your voice never has to wait forever.
- **Idle timeout.** If the stream pauses and you still have held text, it is spoken after 0.5 seconds, so speech starts on time.

<a name="tool-calls-assembled-in-real-time"></a>

## Tool calls, assembled in real time

<p align="center">
  <img src="docs/images/tool-assembly.svg" alt="Tool calls, assembled in real time" width="920" />
</p>

The API sends tool arguments in pieces, sometimes interleaving two parallel tools. The parser keeps one slot per tool index, glues the pieces in order, and only emits `tool_call_complete` when the JSON strictly validates. If the JSON is broken, you get an `error` event with the code `tool_arguments_invalid` instead of a crash.

In code:

```python
for ev in iter_events(chunks):
    if ev.type == "tool_call_complete":
        run(ev.name, **ev.arguments)   # always a complete, valid object
```

<a name="provider-auto-detection"></a>

## Provider auto detection

You do not have to say which provider you use. The first JSON chunk is inspected once, and the right adapter is locked in:

<p align="center">
  <img src="docs/images/provider-detect.svg" alt="Provider auto-detection" width="920" />
</p>

If you know your provider and want to skip the guess, you can always set it yourself:

```python
parse_stream(chunks, provider="groq")
```

And for anything unusual, the generic adapter lets you point at the text field with a simple path:

```python
parse_stream(chunks, provider="generic", text_path="message.content")
```

## The event format

Everything is normalized to one event type, `StreamEvent`, with these kinds:

| type | what it carries |
|---|---|
| `delta` | a piece of visible text |
| `reasoning_delta` | a piece of thinking text (Gemini "thought", OpenAI reasoning) |
| `tool_call_delta` | a fragment of a tool call |
| `tool_call_complete` | a fully assembled, validated tool call |
| `usage` | token counts |
| `metadata` | provider, model, finish reason |
| `error` | something went wrong, with a code |
| `done` | the stream ended |

If you only want sentences, you never see these. They are there for when you need tools, usage, or error handling.

## Buffer presets

| preset | for | what it does |
|---|---|---|
| `"voice"` (default) | TTS and Voice AI | sentence strategy, 0.5s idle flush, strips markdown and emoji |
| `"ui"` | live captions, chat | sentence strategy, no idle flush |
| `"off"` | raw passthrough | no buffering at all |

Every detail is tunable: minimum and maximum sizes, custom sentence enders, extra abbreviations, your own control tags like `<pause>`, code block mode, and more. See the guides linked above.

## Error handling

Two policies, your choice:

- `on_error="raise"` (default): a bad chunk raises a typed exception you can catch.
- `on_error="skip"`: a bad chunk becomes an `error` event and the stream continues.

Error codes are stable: `malformed_chunk`, `tool_arguments_invalid`, `provider_error`.

## Repository layout

```
llmstream/
├── README.md                  <- you are here
├── logo.svg                   <- the banner above
├── docs/images/               <- the flowchart pictures in this file
├── spec/                      <- the detailed, language agnostic specification
│   ├── SPEC.md                <- event model, defaults, presets, error policy
│   ├── BUFFER-ALGORITHM.md    <- exact buffer rules, edge cases
│   ├── TOOL-PARSER-ALGORITHM.md <- exact tool assembly rules
│   ├── PROVIDER-PROTOCOLS.md  <- wire formats per provider
│   └── test-vectors/          <- shared JSON tests, 25 files
├── python/                    <- the Python package (54 tests, all passing)
├── js/                        <- the TypeScript package (53 tests, all passing)
├── examples/                  <- runnable examples, no API key needed
└── plans/                     <- architecture plan with flowcharts
```

## Testing and parity

Both packages run the same 25 JSON test vectors from `spec/test-vectors/`:

```bash
cd python && python -m pytest tests/ -q    # 54 passed
cd js && npx vitest run                     # 53 passed
```

If a new rule is added to the spec, a new vector is added, and both languages must pass it. That is how we keep Python and JavaScript in perfect agreement.

<a name="examples"></a>

## Examples

| example | what it shows |
|---|---|
| [python_voice_agent.py](examples/python_voice_agent.py) | a fake OpenAI stream fed into TTS. Sentence holding, markdown stripping, idle flushing. |
| [python_tool_agent.py](examples/python_tool_agent.py) | fragmented tool call JSON, assembled and dispatched only when valid. |
| [react-live-caption](examples/react-live-caption) | a Vite + React app with live captions, optional speech, and a stop button. Runs fully offline. |

All three run without an API key.

## License

MIT
