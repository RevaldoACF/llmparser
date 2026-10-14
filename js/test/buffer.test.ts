/** Tokens -> expected sentences (shared with Python) */
import { describe, expect, it } from "vitest";
import { SentenceBuffer, type BufferOptions } from "../src/index";
import { loadVectors } from "./vectors";

const vectors = loadVectors("buffer");

describe.each(vectors)("$name", (vec) => {
  it("tokens → sentences", () => {
    const buf = new SentenceBuffer(vec.options as BufferOptions);
    const out: string[] = [];
    for (const token of vec.input.tokens) out.push(...buf.feed(token));
    out.push(...buf.close());
    expect(out).toEqual(vec.expected_sentences);
  });
});