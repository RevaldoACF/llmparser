import { useCallback, useRef, useState } from "react";
import { useLLMStream } from "llmstream/react";
import type { ToolCall } from "llmstream";

const SPEAK = typeof window !== "undefined" && "speechSynthesis" in window;

function speak(text: string) {
  if (!SPEAK) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1;
  window.speechSynthesis.speak(u);
}

export default function App() {
  const [prompt, setPrompt] = useState("Tell me a short story.");
  const [useVoice, setUseVoice] = useState(true);

  const useVoiceRef = useRef(useVoice);
  useVoiceRef.current = useVoice;

  const { sentences, partial, toolCalls, status, error, start, abort, reset } =
    useLLMStream({
      buffer: "voice",
      onSentence: useCallback((s: string) => {
        if (useVoiceRef.current) speak(s);
      }, []),
      onToolCall: useCallback((tc: ToolCall) => {
        console.log("tool call ready:", tc.name, tc.arguments);
      }, []),
    });

  const running = status === "streaming";

  const onSend = () => {
    window.speechSynthesis?.cancel();
    reset();
    start("/mock-sse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
      provider: "openai",
    });
  };

  return (
    <div className="app">
      <header>
        <h1>
          llmstream <span className="dim">· live caption</span>
        </h1>
        <p className="dim">
          Raw SSE → sentence buffer → complete sentences. Sentences are held
          until they are whole, so captions and speech never break mid-sentence.
        </p>
      </header>

      <div className="controls">
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Your prompt…"
          disabled={running}
        />
        {running ? (
          <button className="stop" onClick={abort}>
            ■ Stop
          </button>
        ) : (
          <button onClick={onSend}>▶ Stream</button>
        )}
        <label className="dim">
          <input
            type="checkbox"
            checked={useVoice}
            onChange={(e) => setUseVoice(e.target.checked)}
            disabled={!SPEAK}
          />
          speak
        </label>
        <span className={`status status-${status}`}>{status}</span>
      </div>

      <div className="captions">
        {sentences.map((s, i) => (
          <p key={i} className="sentence">
            {s}
          </p>
        ))}
        {running && (
          <p className="partial">
            {partial}
            <span className="caret" />
          </p>
        )}
        {sentences.length === 0 && !running && (
          <p className="dim hint">Press ▶ Stream to begin.</p>
        )}
      </div>

      {toolCalls.length > 0 && (
        <div className="tools">
          <h2 className="dim">Validated tool calls</h2>
          {toolCalls.map((tc) => (
            <div key={tc.index} className="tool">
              <code>
                {tc.name}({JSON.stringify(tc.arguments)})
              </code>
            </div>
          ))}
        </div>
      )}

      {error && <pre className="error">{error.message}</pre>}

      <footer className="dim">
        buffer: "voice" · tag guard on <code>{"`"}</code> + fences · idle flush
        500 ms · zero dependencies
      </footer>
    </div>
  );
}
