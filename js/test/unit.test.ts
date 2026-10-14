import { describe, expect, it } from "vitest";
import {
  LLMStreamError,
  SentenceBuffer,
  partialJson,
  parseStream,
  sanitizeForTts,
  wrapStream,
  type BufferOptions,
} from "../src/index";

// Boundary rules (edge case catalog E1, E3, E4, E17)

describe("boundary rules", () => {
  const run = (text: string, opts: BufferOptions = { minChunkSize: 5 }) => {
    const buf = new SentenceBuffer(opts);
    return [...buf.feed(text), ...buf.close()];
  };

  it("decimal not boundary", () => {
    expect(run("3.14 is pi. Next?")).toEqual(["3.14 is pi.", "Next?"]);
  });

  it("domain not boundary", () => {
    expect(run("See example.com for details. Bye.")).toEqual([
      "See example.com for details.",
      "Bye.",
    ]);
  });

  it("parenthesized domain boundary", () => {
    expect(run("(a.com). Hello there.")).toEqual(["(a.com).", "Hello there."]);
  });

  it("ellipsis single boundary", () => {
    expect(run("Wait... what?")).toEqual(["Wait... what?"]);
  });

  it("abbreviation", () => {
    expect(run("Dr. Smith went home. He slept.")).toEqual([
      "Dr. Smith went home.",
      "He slept.",
    ]);
  });

  it("closing quote swallowed", () => {
    const out = run("'Done.' he said. More words here.");
    expect(out[0]).toBe("'Done.' he said.");
    expect(out[1]).toBe("More words here.");
  });
});

// Tag guard

describe("tag guard", () => {
  it("partial backtick withheld then released", () => {
    const buf = new SentenceBuffer({ minChunkSize: 5 });
    expect(buf.feed("End of word. ``")).toEqual(["End of word."]);
    const out = [...buf.feed("not a fence. Next."), ...buf.close()];
    expect(out.join(" ")).toContain("not a fence.");
  });

  it("custom tag held until complete", () => {
    const buf = new SentenceBuffer({
      minChunkSize: 5,
      guardTagsExtra: ["<tag>", "</tag>"],
    });
    expect(buf.feed("First sentence here. <ta")).toEqual(["First sentence here."]);
    const out = [...buf.feed("g>body</tag> Second sentence!"), ...buf.close()];
    expect(out.join(" ")).toContain("<tag>body</tag>");
  });

  it("code fence passthrough", () => {
    const buf = new SentenceBuffer({ minChunkSize: 10 });
    const out = [
      ...buf.feed("Here is code: ```"),
      ...buf.feed("\nprint('hi')\n```"),
      ...buf.feed(" Done. All good."),
      ...buf.close(),
    ];
    expect(out).toEqual(["Here is code:", "```\nprint('hi')\n```", "Done. All good."]);
  });
});

// Sanitizer

describe("sanitizer", () => {
  it("strips markdown + emoji + whitespace", () => {
    expect(sanitizeForTts("  **bold** and *it*  😀 text ")).toBe("bold and it text");
    expect(sanitizeForTts("[label](http://x.y) ok")).toBe("label ok");
    expect(
      sanitizeForTts("```\ncode\n``` tail", { codeBlockMode: "sanitize" }),
    ).toBe("(code) tail");
    expect(sanitizeForTts("```\ncode\n``` tail", { codeBlockMode: "drop" })).toBe(
      "tail",
    );
    // fences left for the tag-guard, defensive
    // inline-code rule consumes the leftover backticks
    expect(sanitizeForTts("```\ncode\n``` tail")).toBe("code tail");
  });
});

// Idle timeout (async only)

describe("idle timeout", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function* slowChunks() {
    yield 'data: {"choices":[{"delta":{"content":"A very long partial "}}]}\n\n';
    await sleep(150); // > 50ms idle timeout
    yield 'data: {"choices":[{"delta":{"content":"sentence here. End!"}}]}\n\n';
    yield "data: [DONE]\n\n";
  }

  it("flushes on idle gap", async () => {
    const out: string[] = [];
    for await (const s of parseStream(slowChunks(), {
      buffer: { minChunkSize: 10, maxBufferSize: 1000, idleTimeoutMs: 50 },
      provider: "openai",
    }))
      out.push(s);
    expect(out[0]).toBe("A very long partial");
    expect(out.join(" ")).toContain("sentence here.");
  });
});

// wrapStream HOF + presets

describe("wrapStream", () => {
  it("wraps an async generator", async () => {
    const gen = wrapStream({ buffer: { minChunkSize: 5 } })(
      (async function* () {
        yield 'data: {"choices":[{"delta":{"content":"Hello world. Bye!"}}]}\n\n';
        yield "data: [DONE]\n\n";
      }) as any,
    );
    const out: string[] = [];
    for await (const s of gen()) out.push(s);
    expect(out).toEqual(["Hello world.", "Bye!"]);
  });

  it("buffer 'off' passes deltas through", async () => {
    const out: string[] = [];
    for await (const s of parseStream(
      [
        'data: {"choices":[{"delta":{"content":"ab"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"cd"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
      { buffer: "off" },
    ))
      out.push(s);
    expect(out).toEqual(["ab", "cd"]);
  });

  it("empty stream yields nothing", async () => {
    const out: string[] = [];
    for await (const s of parseStream([], { buffer: "voice" })) out.push(s);
    expect(out).toEqual([]);
  });

  it("pre-parsed dict input", async () => {
    const out: string[] = [];
    for await (const s of parseStream(
      [
        { choices: [{ delta: { content: "Hi there. Bye!" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ] as any,
      { buffer: { minChunkSize: 5 }, provider: "openai" },
    ))
      out.push(s);
    expect(out).toEqual(["Hi there.", "Bye!"]);
  });
});

// partialJson

describe("partialJson", () => {
  it("complete", () => expect(partialJson('{"a": 1}')).toEqual({ a: 1 }));
  it("open object", () => expect(partialJson('{"a": 1')).toEqual({ a: 1 }));
  it("dangling colon", () => expect(partialJson('{"a":')).toEqual({ a: null }));
  it("dangling comma", () => expect(partialJson('{"a": 1,')).toEqual({ a: 1 }));
  it("nested", () => expect(partialJson('{"a": [1, 2,')).toEqual({ a: [1, 2] }));
  it("open string", () => expect(partialJson('{"a": "bc')).toEqual({ a: "bc" }));
  it("garbage → null", () => expect(partialJson("{,,}")).toBeNull());
  it("empty → null", () => expect(partialJson("")).toBeNull());
});

// SSE robustness + errors

describe("robustness", () => {
  it("UTF-8 split mid-codepoint", async () => {
    const enc = new TextEncoder();
    const raw = enc.encode(
      'data: {"choices":[{"delta":{"content":"caf\u00e9. Hi!"}}]}\n\n',
    );
    const split = [...raw].indexOf(0xc3) + 1;
    const out: string[] = [];
    for await (const s of parseStream(
      [raw.slice(0, split), raw.slice(split)],
      { buffer: { minChunkSize: 5 }, provider: "openai" },
    ))
      out.push(s);
    expect(out).toEqual(["caf\u00e9.", "Hi!"]);
  });

  it("malformed chunk raises by default", async () => {
    await expect(
      (async () => {
        for await (const _s of parseStream(
          ["data: {broken json}\n\n"],
          { buffer: { minChunkSize: 5 } },
        ))
          void _s;
      })(),
    ).rejects.toThrow(LLMStreamError);
  });

  it("malformed chunk skipped", async () => {
    const out: string[] = [];
    for await (const s of parseStream(
      [
        "data: {broken}\n\n",
        'data: {"choices":[{"delta":{"content":"Ok fine. Done!"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
      { buffer: { minChunkSize: 5 }, on_error: "skip" },
    ))
      out.push(s);
    expect(out).toEqual(["Ok fine.", "Done!"]);
  });

  it("reasoning + done events", async () => {
    const { parseEvents } = await import("../src/index");
    const events: any[] = [];
    for await (const ev of parseEvents([
      'data: {"model":"gpt-4o","choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}\n\n',
      "data: [DONE]\n\n",
    ]))
      events.push(ev);
    expect(events).toEqual(
      expect.arrayContaining([{ type: "reasoning_delta", text: "thinking" }]),
    );
    expect(events[events.length - 1]).toEqual({ type: "done" });
  });

  it("pending property", () => {
    const buf = new SentenceBuffer({ minChunkSize: 50 });
    buf.feed("Short part");
    expect(buf.pending).toBe("Short part");
  });
});