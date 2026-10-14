import { describe, expect, it } from "vitest";
import { parseEvents } from "../src/index";
import { loadVectors } from "./vectors";

function match(expected: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(expected)) {
    if (k === "type") {
      if (actual.type !== v) return false;
      continue;
    }
    if (k === "code" && actual.type === "error") {
      // error messages are parser-specific
      if (actual.code !== v) return false;
      continue;
    }
    if (!(k in actual)) return false;
    const a = actual[k];
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const av = a as Record<string, unknown>;
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>))
        if (av[ck] !== cv) return false;
    } else if (a !== v) {
      return false;
    }
  }
  return true;
}

const vectors = loadVectors("wire");

describe.each(vectors)("$name", (vec) => {
  it("wire → events", async () => {
    const actual: Record<string, unknown>[] = [];
    for await (const ev of parseEvents(vec.chunks, {
      provider: (vec.provider as any) ?? "auto",
      streamFormat: (vec.stream_format as any) ?? "auto",
      on_error: (vec.on_error as any) ?? "skip",
    })) {
      actual.push(ev as unknown as Record<string, unknown>);
    }
    const expected = vec.expected_events as Record<string, unknown>[];
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
      expect(match(expected[i], actual[i]), `event #${i}`).toBe(true);
    }
  });
});