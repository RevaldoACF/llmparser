import { describe, expect, it } from "vitest";
import { parseStream, type BufferOptions } from "../src/index";
import { loadVectors } from "./vectors";

const vectors = loadVectors("e2e");

describe.each(vectors)("$name", (vec) => {
  it("wire → sentences", async () => {
    const out: string[] = [];
    for await (const s of parseStream(vec.chunks, {
      provider: (vec.provider as any) ?? "auto",
      buffer: (vec.options as BufferOptions) ?? "voice",
      on_error: (vec.on_error as any) ?? "skip",
    })) {
      out.push(s);
    }
    expect(out).toEqual(vec.expected_sentences);
  });
});