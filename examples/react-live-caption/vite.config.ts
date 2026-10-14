import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * A tiny dev-only middleware that streams an OpenAI-format SSE response,
 * word by word, with a small delay — so the demo feels like a real LLM
 * stream with no network access and no API key.
 *
 * The stream intentionally contains:
 *   * markdown (bold, a code fence)  -> exercises the tag guard + sanitizer
 *   * emoji                          -> stripped by the "voice" buffer
 *   * a fragmented tool call         -> exercises StreamingToolParser
 *
 * Point the hook at any real endpoint instead of `/mock-sse` to go live.
 */
function mockSse(): Plugin {
  const words = [
    "Hello! I am a **streaming** voice agent. ",
    "First I verify the weather, then I will show you a tiny code block. ",
    "Here it comes, a fenced block of code. ",
    "```",
    "console.log('hi')",
    "```",
    " And finally I call a tool for you. 🎉 ",
    "That is all, and I hope it sounds natural!",
  ];

  const sse = (payload: unknown, res: ServerResponse) =>
    res.write(`data: ${JSON.stringify(payload)}\n\n`);

  return {
    name: "llmstream-mock-sse",
    configureServer(server) {
      server.middlewares.use("/mock-sse", (req: IncomingMessage, res: ServerResponse) => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        let i = 0;
        // first chunk: open a tool call whose arguments arrive in fragments
        const toolPieces = ['{"city": "Ja', 'karta"}'];
        let toolIdx = 0;

        const timer = setInterval(() => {
          // weave tool-call fragments between the prose words
          if (i === 4 && toolIdx < toolPieces.length) {
            const piece = toolPieces[toolIdx];
            sse({
              object: "chat.completion.chunk",
              choices: [{ delta: { tool_calls: [{ index: 0, type: "function", ...(toolIdx === 0 ? { id: "call_1" } : {}), function: { ...(toolIdx === 0 ? { name: "get_weather" } : {}), arguments: piece } }] }, index: 0 }],
            }, res);
            toolIdx += 1;
            return;
          }

          if (i < words.length) {
            sse({
              object: "chat.completion.chunk",
              choices: [{ delta: { content: words[i] + " " }, index: 0 }],
            }, res);
            i += 1;
            return;
          }

          sse({
            object: "chat.completion.chunk",
            choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
          }, res);
          res.write("data: [DONE]\n\n");
          res.end();
          clearInterval(timer);
        }, 140);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mockSse()],
});