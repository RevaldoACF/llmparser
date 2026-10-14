<p align="center">
  <img src="docs/images/banner.svg" alt="llmstream" width="760" />
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

When an LLM streams an answer, it arrives in tiny pieces, a few characters at a time. Most consumers want complete, clean text: a chat UI, a live caption track, a search index, or a text to speech engine. Feeding `"The"`, then `"sky"`, then `"is"` to any of them produces choppy, broken output. You want to hand over `"The sky is blue."` as one complete piece.

`llmstream` solves exactly that. It takes the raw stream from any provider, waits until a sentence is complete, cleans it up, and hands it to you. Your app displays, stores, or speaks each sentence as it arrives.

It also solves two more streaming problems that catch everyone:

1. **Tool calls arrive in pieces.** The JSON arguments for a tool call come in tiny fragments. `llmstream` glues them together and only calls your function when the JSON is 100% valid.
2. **Code blocks and tags get cut in half.** A fence like ` ``` ` can arrive split across two chunks. `llmstream` notices this and holds the text until the tag or block is whole, so consumers never receive a half tag or a broken fence.

## Why this library

| | |
|---|---|
| **It is tiny.** | Zero runtime dependencies in Python. Zero runtime dependencies in JavaScript. It only uses what your language already has. |
| **It is easy.** | One import, one function call. No config, no setup. It even figures out which provider you are using by itself. |
| **It works with almost every provider.** | OpenAI, Anthropic, Google Gemini, Groq, and a generic adapter for Ollama, OpenRouter, vLLM, or any OpenAI compatible API. |
| **Python and JavaScript behave identically.** | Both run the same test vectors. If they ever disagree, that is a bug we fix. |

## How it works

<p align="center">
  <img src="docs/images/pipeline-overview.svg" alt="How llmstream works" width="920" />
</p>

Five steps, all inside one function call:

1. **Raw stream.** Bytes or strings from the API, whatever shape they are in.
2. **Wire decoder.** Understands Server Sent Events (SSE) and JSON Lines, even when a chunk is cut in the middle of a word or a UTF-8 character.
3. **Provider adapter.** Turns the provider specific format into one universal event format (text, reasoning, tools, usage, errors). The provider is detected automatically.
4. **Sentence buffer.** The smart part. It holds text until a sentence is complete, then cleans it for display or speech (no markdown, no emoji).
5. **Done.** You get clean sentences, ready to display, process, or speak.

<a name="quick-start-python"></a>

## Quick start: Python

```python
from llmstream import parse_stream

async def main():
    chunks = openai_stream(...)          # your raw chunk iterator
    async for sentence in parse_stream(chunks):
        print(sentence)                  # complete sentences, ready to display or speak
```

That is the entire integration. Provider detection, wire decoding, sentence buffering, and text cleaning all happen inside `parse_stream`.

You can also use it as a decorator, so your own generator yields sentences:

```python
from llmstream import stream_parser

@stream_parser(buffer="ui")
async def chat(prompt):
    async for chunk in raw_stream(prompt):
        yield chunk

async for sentence in chat("Hello!"):
    print(sentence)
```

Full Python guide: [python/README.md](python/README.md)

<a name="quick-start-javascript"></a>

## Quick start: JavaScript

```js
import { parseStream } from "llmstream";

const res = await fetch(url, { method: "POST", body: JSON.stringify(body) });

for await (const sentence of parseStream(res.body)) {
  console.log(sentence);                 // display, caption, or pass to TTS
}
```

It accepts a `ReadableStream`, an async iterable, or a plain iterable. The JavaScript API also has:

- `wrapStream` : the JS version of the decorator.
- `sentenceTransform` : a `TransformStream` you can pipe a response straight into.
- `useLLMStream` : a React hook with live captions, optional speech, tool calls, and a stop button.

Full JavaScript guide: [js/README.md](js/README.md)

<a name="quick-start-react"></a>

## Quick start: React

```tsx
import { useLLMStream } from "llmstream/react";

function Chat() {
  const { sentences, partial, status, start, abort } = useLLMStream({
    onSentence: (s) => speak(s),            // optional: forward each sentence to TTS
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
- **Code blocks.** Once a code block opens, it is handled as a unit. You can pass it through raw, drop it, or replace it with the word "(code)" so code is never shown or spoken verbatim.
- **Complete sentence.** The scanner looks for a real end of sentence (`. ! ? … 。 ！`). It knows that `"Mr."` is not the end of a sentence, and that the dot in `"3.14"` is not a sentence break either.
- **Not too short.** A sentence shorter than 40 codepoints is merged with the next one, so consumers do not receive tiny fragments.
- **Not too long.** If the buffer reaches 400 codepoints without a sentence break, it is force flushed. Output never has to wait forever.
- **Idle timeout.** With the voice preset, if the stream pauses and you still have held text, it is flushed after 0.5 seconds, so output starts on time.

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
